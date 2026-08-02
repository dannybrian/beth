// The harness-defined SHAPE of a unit of work, and the reader seam.
//
// The harness never learns a project's storage format. It defines this shape; a
// READER produces it from whatever the project actually keeps. `/plans` is a
// BUILT-IN reader (see plansReader.ts) because dated-markdown-with-frontmatter is
// Danny's convention across repos, not any one repo's private format — so beadgame
// ships nothing and changes nothing. A project whose work lives somewhere foreign
// (GitHub issues, Linear, a bespoke tracker) supplies its own reader instead.

/** Harness vocabulary. A reader maps whatever the project stores into this. */
export type WorkStatus =
  | 'idea'
  | 'planning'
  | 'active'
  | 'blocked'
  | 'awaiting-eyes'
  | 'review'
  | 'shipped'
  | 'parked'
  | 'unknown';

/**
 * Work that is genuinely IN PROGRESS. Note what is not here: `awaiting-eyes` is
 * not in-flight work, which is exactly why it needs its own set below.
 */
export const IN_FLIGHT: WorkStatus[] = ['active', 'blocked', 'planning'];

/**
 * Work that is finished except for DANNY.
 *
 * `awaiting-eyes` is tulito's invention and, per its own plans/README, "the
 * reason this workflow was ported": every mechanical gate has passed and only
 * his read or listen is owed. That makes it the batched-confirmation queue —
 * "here are the four things needing your eyes, let's clear them in one sitting"
 * — which is the single most useful thing the panel can surface.
 *
 * It is deliberately NOT folded into IN_FLIGHT. It is not work in progress; it
 * is work stopped on him, and conflating the two would both misreport progress
 * and bury the queue among thirty active plans.
 */
export const NEEDS_EYES: WorkStatus[] = ['awaiting-eyes'];

/**
 * What the panel renders, what the stream carries, and what `plans` answers with
 * by default — ordered, and this is the order the panel groups them in.
 *
 * NEEDS_EYES comes FIRST. tulito's terminal board ranks it third (after active
 * and blocked) and that is right for that reader: an implementer session asking
 * what is running. This panel has a different reader. It is Danny's surface, and
 * the one pile here that only he can clear belongs at the top of it.
 *
 * `review` is absent on purpose. beadgame's plans/README defines it as a status
 * an audit assigns when the outcome is unclear and a human must reclassify — it
 * is bookkeeping owed to /tidyrepo, not a deliverable awaiting judgement, and
 * mixing it in would dilute the confirmation queue with audit debris. It is a
 * recognised status (so it stops falling to `unknown`) and shows under "show all".
 */
export const LIVE: WorkStatus[] = [...NEEDS_EYES, ...IN_FLIGHT];

export const isInFlight = (s: WorkStatus) => IN_FLIGHT.includes(s);
export const needsEyes = (s: WorkStatus) => NEEDS_EYES.includes(s);
export const isLive = (s: WorkStatus) => LIVE.includes(s);

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
  /** Raw relations as the project wrote them. Format varies — see resolveParents. */
  dependsOn: string[];
  /**
   * Repo-relative path of this item's UMBRELLA, when one can be proven.
   *
   * `depends_on` does double duty: prerequisites AND parentage. The separating
   * convention, measured across 623 plans in both repos, is that the parent is
   * the FIRST entry when that entry is an umbrella — with not one counterexample
   * (tulito 40/44 plans, beadgame 4/94, zero cases of an umbrella appearing
   * anywhere but first). So this stays conservative: no umbrella first, no parent,
   * and the item renders exactly as it does today.
   */
  parent?: string;
  /** Named as an umbrella, and therefore able to be a parent. */
  isUmbrella?: boolean;
  /** Which reader produced this, for debugging a wrong-looking panel. */
  reader: string;
  /**
   * This item is the DIRECTOR ROLE LOCK, not a deliverable.
   *
   * The role is held by claiming a plan, because `/plans` is the claim mechanism
   * and session records key on `plan_path` — so the lock has to be a file that
   * `/plans claim` can write an `owner:` into. That makes it a plan by
   * construction while being a standing ledger by nature: no Context/Approach/
   * Verification, no tasks, no completion condition, permanently `active`.
   *
   * Left in the work list it sits at the top of Danny's board forever and makes
   * the active count one too many. So it is kept in the index (the claim state is
   * real and worth reading) but excluded from the LIVE set — the mode badge in
   * the header already says who holds the role, and says it better.
   */
  roleLock?: boolean;
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
  /**
   * 'test' is a failing test rather than a plan, and it exists here on purpose:
   * clicking a failure is the SAME gesture as clicking a plan, so it should be
   * the same machinery. It carries its own detail because nothing indexes it.
   */
  kind: 'item' | 'task' | 'test';
  /** Repo-relative path of the item (tasks reference their plan's path). */
  path: string;
  /** What Beth should call it. Already unique — safe to say bare. */
  spoken: string;
  /** Present on kind:'task' — the ordinal within the item. */
  taskIndex?: number;
  /** Present on kind:'task' — 1-based line, for a handoff that jumps there. */
  line?: number;
  /** Present on kind:'test' — the assertion, so she does not have to go read it. */
  detail?: string;
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
