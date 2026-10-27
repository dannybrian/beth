// The workbench — ONE url, boldly on the page: the thing being iterated on
// right now. A dev server, a staging deploy, a PR. Not a bookmark list on
// purpose: the moment it holds two, it answers "what are we working on?" with
// "you choose", which is the question it exists to close.
//
// Like a pin (pins.ts), it is attention, not a fact about the work — so it
// lives in the state dir, per repo, and no project file learns about it. Unlike
// a pin it survives a restart on purpose: the dev server it points at usually
// outlives the harness process that pinned it.
import fs from 'node:fs';
import path from 'node:path';
import type { HarnessConfig } from './config.ts';

/**
 * `source` says who put it there. A pin (his × and her tool) is attention; a
 * run (appRunner.ts) is a fact about a process, and comes down when the process
 * does. Absent on a file written before runs existed, which is a pin.
 */
export type BenchSource = 'pin' | 'run';
export type BenchState = { url: string; label?: string; setAt: string; source?: BenchSource } | null;

export type BenchMessage = { type: 'workbench'; url: string | null; label?: string; source?: BenchSource };

/**
 * Only a url the page can safely hand to an <a href>. The bench renders in
 * every open tab straight off the bus, so a `javascript:` url pinned by a
 * confused tool call would put an executable link in the boldest spot on the
 * page. http(s) only; anything else is refused with the reason.
 */
export function vetBenchUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  const parse = (s: string) => {
    try {
      return new URL(s);
    } catch {
      return null;
    }
  };
  const direct = parse(trimmed);
  if (direct && (direct.protocol === 'http:' || direct.protocol === 'https:')) return { ok: true, url: direct.href };
  // "localhost:3000" is the most natural thing to hand this, and the parser
  // reads it as scheme `localhost:` — so anything without an explicit
  // `scheme://` gets one try as http before being refused. `javascript:` and
  // friends cannot ride this in: http-prefixed they fail to parse (the colon
  // lands in the port), and un-prefixed they fall through to the refusal below.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const retried = parse(`http://${trimmed}`);
    if (retried) return { ok: true, url: retried.href };
  }
  if (direct) return { ok: false, reason: `only http(s) can be pinned, not ${direct.protocol}` };
  return { ok: false, reason: `not a url: ${trimmed || '(empty)'} — e.g. http://localhost:3000` };
}

export class Workbench {
  private file: string;
  private state: BenchState = null;

  constructor(cfg: Pick<HarnessConfig, 'stateDir'>) {
    this.file = path.join(cfg.stateDir, 'workbench.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // Re-vet on load: the file is ours, but "we wrote it" is a weaker proof
      // than the one the page relies on, and vetting twice costs nothing.
      if (raw && typeof raw.url === 'string' && vetBenchUrl(raw.url).ok) {
        this.state = {
          url: raw.url,
          label: typeof raw.label === 'string' && raw.label ? raw.label : undefined,
          setAt: typeof raw.setAt === 'string' ? raw.setAt : new Date().toISOString(),
          source: raw.source === 'run' ? 'run' : 'pin',
        };
      }
    } catch {
      /* nothing on the bench yet — the right start */
    }
  }

  current(): BenchState {
    return this.state ? { ...this.state } : null;
  }

  set(
    rawUrl: string,
    label?: string,
    source: BenchSource = 'pin'
  ): { ok: true; state: NonNullable<BenchState> } | { ok: false; reason: string } {
    const vetted = vetBenchUrl(rawUrl);
    if (!vetted.ok) return vetted;
    const trimmed = label?.trim();
    this.state = { url: vetted.url, label: trimmed || undefined, setAt: new Date().toISOString(), source };
    this.save();
    return { ok: true, state: { ...this.state } };
  }

  /**
   * A running app's url, offered. Taken only when the bench is empty or holds
   * an earlier run's: a PR he pinned is not displaced by starting the app —
   * the page puts the run's url on the run button instead. True when the bench
   * changed, so the caller knows to publish.
   */
  offerRun(url: string, label?: string): boolean {
    if (this.state && this.state.source !== 'run') return false;
    if (this.state?.url === url && this.state.label === label) return false;
    return this.set(url, label, 'run').ok;
  }

  /**
   * The app went down. Its url comes off — a dead link in the boldest spot on
   * the page is the same lie the build light's stale yellow exists to prevent —
   * but only if it is still the run's: never his pin.
   */
  clearRun(): boolean {
    if (this.state?.source !== 'run') return false;
    this.clear();
    return true;
  }

  /** Returns what was cleared, so the caller can say so. */
  clear(): BenchState {
    const was = this.state;
    this.state = null;
    this.save();
    return was;
  }

  /** The bus message — one shape whether occupied or empty, so the page has one handler. */
  message(): BenchMessage {
    return { type: 'workbench', url: this.state?.url ?? null, label: this.state?.label, source: this.state?.source };
  }

  private save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    } catch {
      /* a bench that forgets on restart beats a harness that will not run */
    }
  }
}
