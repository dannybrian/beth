// Plans Danny put on a shelf.
//
// The panel orders by STATUS, which is right for "what is the state of the work"
// and wrong for "what am I on this week": the three plans he is actually holding
// in his head are scattered through thirty active ones. A pin is his own ordering,
// laid over the index's.
//
// It is deliberately NOT a status. Nothing here is written to a plan file — a pin
// is one person's attention on one machine, not a fact about the work, and a
// terminal session or another repo has no business seeing it. Which is also why
// it lives in the state dir rather than in the repo.
//
// Pinned plans still appear in their normal group. The pin is an ADDITIONAL place
// to find something, never a move — a plan that vanished from `active` because it
// was pinned would make the board lie about what is active.
import fs from 'node:fs';
import path from 'node:path';
import type { HarnessConfig } from './config.ts';
import type { WorkIndex } from './workIndex.ts';
import type { WorkItem } from './workItems.ts';
import { isLive } from './workItems.ts';

export class Pins {
  private file: string;
  /** Ordered: a pin goes on the end, so the shelf does not reshuffle itself. */
  private paths: string[] = [];

  constructor(cfg: Pick<HarnessConfig, 'stateDir'>) {
    this.file = path.join(cfg.stateDir, 'pins.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw)) this.paths = raw.filter((p) => typeof p === 'string');
    } catch {
      /* no pins yet, or a file we cannot read — an empty shelf is the right start */
    }
  }

  all(): string[] {
    return [...this.paths];
  }

  has(p: string): boolean {
    return this.paths.includes(p);
  }

  /** Returns the new state, so a caller can report what it did. */
  set(p: string, pinned: boolean): boolean {
    const at = this.paths.indexOf(p);
    if (pinned && at < 0) this.paths.push(p);
    if (!pinned && at >= 0) this.paths.splice(at, 1);
    this.save();
    return pinned;
  }

  toggle(p: string): boolean {
    return this.set(p, !this.has(p));
  }

  private save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.paths, null, 2));
    } catch {
      /* a shelf that does not survive a restart beats a harness that will not start */
    }
  }
}

/**
 * The work message, with the shelf on it.
 *
 * ⚠️ Pinned items ride the SAME message as the live ones, and are resolved here
 * rather than in the page, because a pinned plan is frequently NOT live — parked,
 * shipped, an idea — and the stream only carries the in-flight slice. A page that
 * filtered its own pinned list out of `items` would show an empty shelf for
 * exactly the plans worth shelving.
 *
 * A pin whose plan has gone (deleted, renamed on disk) resolves to nothing and is
 * quietly skipped: it stays on file in case the plan comes back, and it does not
 * get to break the panel in the meantime.
 */
export function workMessage(work: WorkIndex, pins: Pins) {
  const all = work.all();
  const byPath = new Map(all.map((i) => [i.path, i]));
  return {
    type: 'work' as const,
    items: all.filter((i) => isLive(i.status) && !i.roleLock),
    total: all.length,
    pinned: pins.all().map((p) => byPath.get(p)).filter(Boolean) as WorkItem[],
  };
}
