// WorkIndex — one in-memory index of the project's work, and the only place
// spoken names are assigned.
//
// ONE INDEX, TWO CONSUMERS: the panel reads it over the existing SSE stream, and
// Beth reads it through the `plans` tool. That symmetry is the point — when Danny
// glances at the panel and when he asks "what's in flight?" out loud, both answers
// have to come from here, or they will disagree and he will stop trusting both.
//
// File watching rather than polling: the harness is already a long-lived local
// process sitting next to the files, so it can be current within milliseconds
// instead of the dashboard's 30-second poll.
import fs from 'node:fs';
import { assignSpokenNames } from './spokenName.ts';
import { LIVE, isInFlight, isLive, taskSummary } from './workItems.ts';
import type { WorkItem, WorkReader, WorkRef, WorkStatus } from './workItems.ts';

/** Editors save in bursts (write, rename, chmod). Coalesce before re-reading. */
const DEBOUNCE_MS = 150;
/** Fallback cadence when recursive watching is unavailable. Matches the dashboard. */
const POLL_MS = 30_000;

export class WorkIndex {
  private readers: WorkReader[];
  private items: WorkItem[] = [];
  private subs = new Set<(items: WorkItem[]) => void>();
  private watchers: fs.FSWatcher[] = [];
  private timer: NodeJS.Timeout | null = null;
  private poller: NodeJS.Timeout | null = null;
  private signature = '';

  /**
   * Harness-side name overrides, path → spoken name. Consulted BEFORE a plan's
   * own `name:` frontmatter, so a name given here wins over one in the file.
   *
   * Empty in practice, and no longer the seam it was drafted as: renaming from the
   * panel shipped by WRITING `name:` into the file (`planName.ts`), because a name
   * held only here would be invisible to `/plans` and to every other reader of the
   * repo. Do not route rename through this map. It survives for drafts, which have
   * no file to carry a name.
   */
  nameOverrides = new Map<string, string>();

  /**
   * Repo-relative path of the plan that IS the director role lock, if the project
   * uses one. Marked and held out of the live set — see WorkItem.roleLock.
   */
  roleLockPath = '';

  constructor(readers: WorkReader[], opts: { roleLockPath?: string } = {}) {
    this.readers = readers;
    this.roleLockPath = opts.roleLockPath ?? '';
  }

  subscribe(fn: (items: WorkItem[]) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  // --- what Danny is currently pointing at ---------------------------------
  //
  // This lives on the SERVER, not in the browser. The original reason is gone
  // (a spoken turn used to bypass the page entirely, back when ElevenLabs dialled
  // in), but the placement outlived it: chips are shared ground across every open
  // tab, and consumption has to be settled in one place or two tabs spend the same
  // reference twice. Both input paths consume from here.

  private pointing: WorkRef[] = [];
  private pointSubs = new Set<(refs: WorkRef[]) => void>();

  onPointingChange(fn: (refs: WorkRef[]) => void): () => void {
    this.pointSubs.add(fn);
    return () => this.pointSubs.delete(fn);
  }

  private pointSeq = -1;

  /**
   * Replace what is being pointed at. Silent — the browser already drew it.
   *
   * `seq` orders the page's updates. Two fetches issued microseconds apart are
   * not guaranteed to arrive in order, and out-of-order delivery here has teeth:
   * a chip-sync landing AFTER the turn that consumed it would resurrect a spent
   * reference and silently staple it to the next spoken turn. Stale seq loses.
   */
  point(refs: WorkRef[], seq?: number) {
    if (seq !== undefined) {
      // `<=`, not `<`: the hazard is a DUPLICATE of an update already applied —
      // the page mirrors chips and then posts the turn carrying the same seq, so
      // the late copy arrives with a seq equal to the one already seen. Treating
      // equal as fresh re-armed a reference the turn had just consumed.
      if (seq <= this.pointSeq) return;
      this.pointSeq = seq;
    }
    this.pointing = refs;
  }

  pointed = () => this.pointing;

  /**
   * Take the references and clear them. CONSUMING, not reading: a reference is
   * spent by the turn that uses it, exactly as the composer chips clear on send.
   * Subscribers are told so the page can drop chips a spoken turn just used.
   */
  takePointed(): WorkRef[] {
    const refs = this.pointing;
    if (!refs.length) return refs;
    this.pointing = [];
    for (const fn of this.pointSubs) {
      try {
        fn(this.pointing);
      } catch {
        /* a dead subscriber must not break a turn */
      }
    }
    return refs;
  }

  all = () => this.items;
  /** Sorted freshest-first: 30+ plans are active at once, so recency is the only
   *  ordering that keeps the top of the panel worth looking at. */
  inFlight = () => this.items.filter((i) => isInFlight(i.status));
  /** What the panel and the `plans` tool show: in-flight PLUS awaiting-eyes. */
  live = () => this.items.filter((i) => isLive(i.status) && !i.roleLock);
  byPath = (p: string) => this.items.find((i) => i.path === p);

  /**
   * A plan by the number an agent said, or NOTHING when the number is ambiguous.
   *
   * Refusing is the whole point. `/plans` counts per scope directory, so beadgame
   * has two plan 22s (unity and backend) and 64 more like it — while every number
   * agents actually cite in practice (174, 176, 182, 186, 190, 198-202) is unique,
   * because those collisions all sit in the low, long-shipped range. Linking the
   * wrong plan confidently is worse than not linking: the reference LOOKS resolved,
   * so nobody checks it. Same rule as links.ts — prove it, or draw nothing.
   */
  byNumber = (n: number) => {
    const hits = this.items.filter((i) => i.number === n);
    return hits.length === 1 ? hits[0] : undefined;
  };

  /** Resolve a reference back to what it points at. */
  resolve(ref: WorkRef): { item: WorkItem; task?: WorkItem['tasks'][number] } | null {
    const item = this.byPath(ref.path);
    if (!item) return null;
    if (ref.kind === 'task' && ref.taskIndex !== undefined) {
      return { item, task: item.tasks[ref.taskIndex] };
    }
    return { item };
  }

  start() {
    this.refresh();
    this.watch();
  }

  stop() {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.timer) clearTimeout(this.timer);
    if (this.poller) clearInterval(this.poller);
  }

  /**
   * Work out which items hang under an umbrella.
   *
   * `depends_on` mixes two relations — prerequisites and parentage — and nothing
   * in either repo's README separates them. What DOES separate them is a
   * convention that turns out to be perfectly consistent: the parent is the FIRST
   * entry, when that entry is an umbrella. Measured over 623 plans, an umbrella
   * appears anywhere other than first exactly zero times.
   *
   * So the rule is deliberately conservative: only a first entry, only when it
   * resolves to a plan named as an umbrella. Everything else keeps no parent and
   * renders flat, which is what beadgame gets today (4 edges) and tulito does not
   * (40). It degrades to the current behaviour rather than guessing.
   *
   * Paths are written inconsistently — full repo-relative in tulito, bare
   * filenames in most of beadgame, occasionally without the `.md` — so resolution
   * falls back to a unique basename with the extension normalised. That leaves
   * exactly 1 unresolved edge across both repos (a target that was renamed or
   * deleted), which is a /tidyrepo matter rather than something to paper over.
   */
  private resolveParents(items: WorkItem[]) {
    const byPath = new Map(items.map((i) => [i.path, i]));
    const byBase = new Map<string, WorkItem[]>();
    for (const i of items) {
      const base = i.path.split('/').pop()!;
      (byBase.get(base) ?? byBase.set(base, []).get(base)!).push(i);
    }
    const resolve = (raw: string): WorkItem | undefined => {
      const hit = byPath.get(raw);
      if (hit) return hit;
      const base = raw.split('/').pop()!.replace(/(\.md)?$/i, '.md');
      const cands = byBase.get(base);
      // An ambiguous basename is no answer at all — better flat than wrong.
      return cands?.length === 1 ? cands[0] : undefined;
    };

    for (const i of items) i.isUmbrella = /umbrella/i.test(i.path) || /umbrella/i.test(i.title);
    for (const i of items) {
      const first = i.dependsOn?.[0];
      if (!first) continue;
      const target = resolve(first);
      if (target && target.isUmbrella && target.path !== i.path) i.parent = target.path;
    }

    // A cycle would hang any renderer that walks upward. Break it rather than
    // trust the data — this costs one pass and removes a whole class of hang.
    for (const i of items) {
      const seen = new Set<string>([i.path]);
      let cur = i.parent;
      while (cur) {
        if (seen.has(cur)) {
          console.warn(`  work: parent cycle at ${i.path} — dropping its parent`);
          i.parent = undefined;
          break;
        }
        seen.add(cur);
        cur = byPath.get(cur)?.parent;
      }
    }
  }

  /** Whole-corpus re-read. ~571 plans in beadgame; measured in tens of ms. */
  refresh() {
    const drafts = this.readers.flatMap((r) => {
      try {
        return r.read();
      } catch (e) {
        console.error(`  work: reader "${r.name}" failed — ${String(e).slice(0, 200)}`);
        return [];
      }
    });

    // Names are assigned HERE, across the combined set from every reader —
    // uniqueness has to hold across readers, not within one.
    const named = assignSpokenNames(
      drafts.map((d) => ({ path: d.path, title: d.title, name: this.nameOverrides.get(d.path) ?? d.name }))
    );

    this.items = drafts
      .map((d) => ({ ...d, spoken: named.get(d.path) ?? d.title, roleLock: d.path === this.roleLockPath }))
      .sort((a, b) => (b.lastTouched ?? '').localeCompare(a.lastTouched ?? '') || a.path.localeCompare(b.path));

    this.resolveParents(this.items);

    // An explicit name that did not stick means two plans asked for the same one.
    // Say so — a silently ignored name is a reference pointing at the wrong plan.
    for (const i of this.items) {
      if (i.name && i.spoken.toLowerCase() !== i.name.toLowerCase()) {
        console.warn(`  work: name "${i.name}" in ${i.path} is already taken — using "${i.spoken}"`);
      }
    }

    // Only wake the UI when something it renders actually changed. A `tick`
    // heartbeat rewrites last_touched on every turn of every terminal session.
    const sig = this.items
      .map((i) => {
        const t = taskSummary(i);
        return `${i.path}|${i.spoken}|${i.status}|${i.parent ?? ''}|${i.claim?.live ? 'L' : i.claim?.owner ? 'o' : ''}|${t ? `${t.done}/${t.total}` : '-'}`;
      })
      .join('\n');
    if (sig === this.signature) return;
    this.signature = sig;
    for (const fn of this.subs) {
      try {
        fn(this.items);
      } catch {
        /* a dead subscriber must not break the index */
      }
    }
  }

  private bump() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), DEBOUNCE_MS);
  }

  private watch() {
    const roots = [...new Set(this.readers.flatMap((r) => r.watchRoots()))];
    let watched = 0;
    for (const root of roots) {
      try {
        // Recursive watching is supported on macOS (FSEvents) and Windows.
        this.watchers.push(fs.watch(root, { recursive: true }, () => this.bump()));
        watched++;
      } catch {
        /* counted below; the poll fallback covers it */
      }
    }
    // A reader that asked for a poll gets one whether or not the watcher armed:
    // the failure it guards against is a watcher that LOOKS armed and delivers
    // nothing (across a sleep), which `watched` cannot see. refresh() publishes
    // only on change, so a quiet poll costs a few reads and nothing else.
    const asked = this.readers.map((r) => r.pollMs ?? 0).filter((ms) => ms > 0);
    const pollMs = watched < roots.length ? Math.min(POLL_MS, ...asked) : asked.length ? Math.min(...asked) : 0;
    if (pollMs) {
      if (watched < roots.length) {
        // Degrade to the dashboard's cadence rather than going silently stale.
        console.warn(`  work: watching ${watched}/${roots.length} roots — polling every ${pollMs / 1000}s for the rest`);
      }
      this.poller = setInterval(() => this.refresh(), pollMs);
      this.poller.unref?.();
    }
    console.log(`  work: ${this.items.length} items from ${roots.length} root(s), ${this.inFlight().length} in flight`);
  }

  /**
   * The pointing half of deixis, rendered for the model.
   *
   * Danny clicked something; this tells Beth WHAT he clicked, in enough detail
   * that she does not have to go read the file to answer a simple question — and
   * tells her what to call it, because the spoken name is the whole reason the
   * reference exists. Without that last instruction she reads the path aloud,
   * which is precisely the thing this feature is for avoiding.
   */
  preamble(refs: WorkRef[]): string {
    if (!refs.length) return '';
    const lines: string[] = [];
    for (const ref of refs) {
      // A failing test is not in the index and never will be — it carries its own
      // detail precisely so it does not need to be. Same gesture, same chip,
      // different source of truth.
      if (ref.kind === 'test') {
        const where = ref.path ? ` — ${ref.path}${ref.line ? `:${ref.line}` : ''}` : '';
        lines.push(`- the failing test "${ref.spoken}"${where}${ref.detail ? `\n    ${ref.detail}` : ''}`);
        continue;
      }
      const hit = this.resolve(ref);
      if (!hit) {
        lines.push(`- "${ref.spoken}" (${ref.path}) — no longer in the index; it may have been moved or renamed.`);
        continue;
      }
      const { item, task } = hit;
      const t = taskSummary(item);
      const bits = [
        item.status,
        item.priority,
        t ? `${t.done} of ${t.total} tasks done` : 'no tasks',
        item.claim?.live ? `CLAIMED by a live session (${item.claim.owner})` : null,
      ].filter(Boolean);
      if (task) {
        lines.push(
          `- the task "${task.spoken}" (${task.done ? 'done' : 'not done'}) on "${item.spoken}" — ${item.path}:${task.line}`
        );
      } else if (item.inbox) {
        // No file to read, so the content comes along. The producer and its
        // reference are facts she can repeat; the text is what he is pointing at.
        const who = `${item.inbox.from}${item.inbox.ref ? ` (${item.inbox.ref})` : ''}`;
        const state = item.inbox.ack ? `${item.inbox.ack.state}` : 'not yet taken';
        lines.push(
          `- the hand-off "${item.spoken}" from ${who}, ${state} — its text:\n    ${item.inbox.text.replace(/\n/g, '\n    ')}`
        );
      } else {
        lines.push(`- "${item.spoken}" — ${item.path} (${bits.join(', ')})`);
      }
    }
    return [
      'Danny is pointing at the following:',
      ...lines,
      'Refer to these by the quoted name when you speak or write. Never read the path aloud.',
      '',
    ].join('\n');
  }

  /** Grouped for display and for the tool, in the harness's in-flight order. */
  grouped(): { status: WorkStatus; items: WorkItem[] }[] {
    return LIVE.map((status) => ({ status, items: this.live().filter((i) => i.status === status) })).filter(
      (g) => g.items.length
    );
  }
}
