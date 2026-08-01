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
   * Empty today and deliberately so: this is the seam for renaming a plan from
   * the panel — useful for an umbrella plan that wants a name reflecting the
   * subplans under it, without editing someone else's file. When that lands it
   * populates this map; nothing else has to change.
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
  // This lives on the SERVER, not in the browser, because a spoken turn never
  // touches the browser: ElevenLabs dials in and the utterance goes straight to
  // the director. Holding the chips only in the page meant clicking a plan and
  // then SPEAKING lost the reference entirely. Both paths now consume from here.

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
        return `${i.path}|${i.spoken}|${i.status}|${i.claim?.live ? 'L' : i.claim?.owner ? 'o' : ''}|${t ? `${t.done}/${t.total}` : '-'}`;
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
    if (watched < roots.length) {
      // Degrade to the dashboard's cadence rather than going silently stale.
      console.warn(`  work: watching ${watched}/${roots.length} roots — polling every ${POLL_MS / 1000}s for the rest`);
      this.poller = setInterval(() => this.refresh(), POLL_MS);
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
      } else {
        lines.push(`- "${item.spoken}" — ${item.path} (${bits.join(', ')})`);
      }
    }
    return [
      'Danny is pointing at the following, from the plans panel:',
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
