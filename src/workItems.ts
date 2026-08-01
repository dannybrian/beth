// The harness-defined SHAPE of a unit of work, and the reader seam.
//
// The harness never learns a project's storage format. It defines this shape; a
// READER produces it from whatever the project actually keeps. `/plans` is a
// BUILT-IN reader (see plansReader.ts) because dated-markdown-with-frontmatter is
// Danny's convention across repos, not any one repo's private format — so beadgame
// ships nothing and changes nothing. A project whose work lives somewhere foreign
// (GitHub issues, Linear, a bespoke tracker) supplies its own reader instead.

/** Harness vocabulary. A reader maps whatever the project stores into this. */
export type WorkStatus = 'idea' | 'planning' | 'active' | 'blocked' | 'shipped' | 'parked' | 'unknown';

/**
 * "In flight" — what the panel shows and what `plans` answers with by default.
 * Ordered: this is also the order the panel groups them in.
 */
export const IN_FLIGHT: WorkStatus[] = ['active', 'blocked', 'planning'];

export const isInFlight = (s: WorkStatus) => IN_FLIGHT.includes(s);

export type WorkTask = {
  /** Ordinal within the item. Identity for a task reference. */
  index: number;
  /** 1-based line in the source file — what a VSCode handoff jumps to. */
  line: number;
  /** Display text, markdown stripped. */
  text: string;
  /** Sayable form — short enough to read aloud without losing the thread. */
  spoken: string;
  done: boolean;
  /** Indent depth, so the panel can show sub-tasks as sub-tasks. */
  depth: number;
};

/**
 * Who holds this item. `live` is the part that matters: a stale `owner` in
 * frontmatter is a dangling claim, not a working implementer. The one-click
 * handoff must refuse on `live`, never on `owner` alone.
 */
export type WorkClaim = {
  owner: string;
  live: boolean;
  sessionId?: string;
  lastHeartbeat?: string;
};

export type WorkItem = {
  /** Repo-relative path. Machine identity, and what a handoff opens. */
  path: string;
  /** Full human title — read on screen, never aloud. */
  title: string;
  /**
   * SPOKEN form. Unique across the whole index and sayable in a sentence.
   * This is the half of a reference that makes deixis work: Danny clicks, Beth
   * says "the context diet plan" — not the path.
   */
  spoken: string;
  /**
   * An explicit name the item declared for itself (`name:` in frontmatter).
   * Kept alongside the resolved `spoken` so the panel can show which plans are
   * named on purpose vs. named by derivation — and so a future rename affordance
   * has somewhere to write to.
   */
  name?: string;
  status: WorkStatus;
  priority?: string;
  started?: string;
  lastTouched?: string;
  tags: string[];
  claim: WorkClaim | null;
  /** EMPTY MEANS NO TASKS, not zero-of-zero. See taskSummary(). */
  tasks: WorkTask[];
  /** Which reader produced this, for debugging a wrong-looking panel. */
  reader: string;
};

/** A reader supplies everything but the spoken name — the index assigns those,
 *  because uniqueness has to hold across ALL readers, not within one. */
export type WorkItemDraft = Omit<WorkItem, 'spoken'>;

export type WorkReader = {
  name: string;
  /** Absolute directories whose contents changing should trigger a re-read. */
  watchRoots(): string[];
  /** Whole-corpus re-read. Kept cheap enough to run on every debounced change. */
  read(): WorkItemDraft[];
};

/**
 * A REFERENCE IS A PAIR — a spoken name Beth can read back naturally, plus the
 * path underneath. Neither half works alone: you cannot say a path out loud, and
 * a name alone does not resolve. Everything about clicking-to-point is this type.
 */
export type WorkRef = {
  kind: 'item' | 'task';
  /** Repo-relative path of the item (tasks reference their plan's path). */
  path: string;
  /** What Beth should call it. Already unique — safe to say bare. */
  spoken: string;
  /** Present on kind:'task' — the ordinal within the item. */
  taskIndex?: number;
  /** Present on kind:'task' — 1-based line, for a handoff that jumps there. */
  line?: number;
};

/**
 * Task progress, or NULL when the plan has no checkboxes at all.
 *
 * Load-bearing distinction: today most plans have no checkboxes (they are prose),
 * so "no tasks" is the common case, not an edge case. Rendering that as "0%
 * complete" would report every prose plan as untouched — which is a lie that
 * looks like data. The null forces every caller to say "no tasks" instead.
 */
export function taskSummary(item: WorkItem): { done: number; total: number; pct: number } | null {
  if (!item.tasks.length) return null;
  const done = item.tasks.filter((t) => t.done).length;
  return { done, total: item.tasks.length, pct: Math.round((done / item.tasks.length) * 100) };
}
