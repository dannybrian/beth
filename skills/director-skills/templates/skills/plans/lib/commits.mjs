// .claude/skills/plans/lib/commits.mjs
//
// The derived `commits:` list, and the two hand-authored corrections to it.
//
// A plan's `commits:` field is rebuilt WHOLESALE from git on every sync, so a
// hand-repaired list survives exactly until the next commit. That is the right
// design — git is the source of truth — but it left no way to (a) disown a
// commit whose trailer is simply wrong, or (b) claim a commit whose trailer
// names another plan (or no plan at all), and trailers in history cannot be
// rewritten. `commits_exclude:` closes (a); `commits_include:` closes (b).
// Both are authored once, and every sync path re-applies them.
//
// Pure — no fs, no git. index.mjs supplies the derived shas and the plan's
// frontmatter.

/**
 * Frontmatter fields that hold short shas, and must therefore never be read
 * through the generic YAML scalar path (see parseShaListValue).
 */
export const SHA_LIST_KEYS = new Set(['commits', 'commits_exclude', 'commits_include']);

function stripQuotes(s) {
  const v = String(s).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Parse an inline sha list WITHOUT numeric coercion.
 *
 * A short sha is a string that happens to be spelled in hex, and roughly 1 in
 * 256 of them (measured: 0.39% of 7-char shas) is all digits with a leading
 * zero — `0049719`. The generic scalar parser matches /^-?\d+$/ and hands back
 * `parseInt('0049719')` = 49719, silently destroying the sha. Observed
 * consequences, all real: a `commits_exclude` entry stops matching the commit it
 * names, so the exclusion silently does nothing; the field itself is rewritten
 * as the mangled number on the next sync; and INDEX.json reports a sha no git
 * command will resolve. It is data-dependent, so it presents as a rare flake
 * rather than a bug — which is exactly why it has to be fixed at the parser.
 */
export function parseShaListValue(raw) {
  const v = String(raw ?? '').trim();
  if (v === '' || v === '~' || v === 'null') return [];
  if (!(v.startsWith('[') && v.endsWith(']'))) return normalizeShaList([stripQuotes(v)]);
  const inner = v.slice(1, -1).trim();
  if (inner === '') return [];
  return normalizeShaList(inner.split(',').map(stripQuotes));
}

/**
 * Coerce a frontmatter value into a list of sha STRINGS.
 *
 * Our frontmatter parser turns /^-?\d+$/ into a number, so an all-digit short
 * sha (e.g. 44002735) arrives as the number 44002735 — which then reached
 * INDEX.json as a JSON number, a type no consumer can use as a sha, and one
 * that would silently drop a leading zero. Normalizing on READ is the durable
 * fix: re-serializing the string still emits a bare 44002735, so anything that
 * re-parses must normalize again.
 */
export function normalizeShaList(v) {
  if (!Array.isArray(v)) return [];
  return v.map((s) => (s === null || s === undefined ? '' : String(s).trim())).filter(Boolean);
}

/** Shortest abbreviation git will hand out in practice; below this a "sha" is a typo. */
const MIN_SHA_LEN = 4;

/**
 * Do two abbreviated shas name the same commit?
 *
 * git chooses the abbreviation length itself and it grows as the repo does, so
 * a sha recorded as 7 chars and re-derived as 8 must still match — prefix, in
 * whichever direction is shorter. The MIN_SHA_LEN floor stops a blank or
 * one-character typo in `commits_exclude` from prefix-matching (and erasing)
 * every commit on the plan.
 */
export function shaMatches(a, b) {
  const x = String(a ?? '').trim().toLowerCase();
  const y = String(b ?? '').trim().toLowerCase();
  if (x.length < MIN_SHA_LEN || y.length < MIN_SHA_LEN) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * Drop the excluded shas from a derived list, preserving order (oldest first).
 */
export function filterExcludedCommits(shas, excludes) {
  const drop = normalizeShaList(excludes);
  if (drop.length === 0) return [...(shas || [])];
  return (shas || []).filter((sha) => !drop.some((ex) => shaMatches(sha, ex)));
}

/**
 * Merge the hand-authored `commits_include:` shas into a derived list.
 *
 * Included shas append, in their own frontmatter order, AFTER the
 * trailer-derived ones — not date-ordered against them. This module is pure
 * by design (no git, no fs; see file header), and date-ordering an included
 * sha against the derived list would mean either handing this function a git
 * lookup or making every caller pre-sort before calling in. Appending is the
 * simpler option, and it costs nothing the field's own use case needs: the
 * whole reason a sha needs `commits_include:` is that it carries no trailer
 * (or the wrong one) for this plan, so there was never a derived position for
 * it to slot into chronologically in the first place — "known irregular
 * commit, listed after the regular ones" is an accurate reading, not a loss.
 *
 * Dedup uses shaMatches, so an include entry that already names a derived
 * commit (in any abbreviation length) is skipped rather than duplicated —
 * the same cross-length tolerance filterExcludedCommits already applies.
 */
export function mergeIncludedCommits(shas, includes) {
  const add = normalizeShaList(includes);
  const base = [...(shas || [])];
  if (add.length === 0) return base;
  for (const inc of add) {
    if (!base.some((s) => shaMatches(s, inc))) base.push(inc);
  }
  return base;
}

// ─── What counts as a `Plan: <path>` trailer — the ONE shared definition ───
//
// index.mjs has two independent consumers of "is this line a Plan: trailer,
// and for which path": the derivation grep (commitsForPlan, matches a KNOWN
// path against git history) and the post-commit extraction (cmdPostCommit,
// discovers an UNKNOWN path from HEAD's own message so it knows which plan(s)
// to sync). Two definitions in one file is exactly the drift class this
// exists to close: derivation was loosened to tolerate a trailing `(Task N)`
// annotation first, and extraction silently kept the old strict tail — so the
// post-commit incremental sync no-opped for precisely the annotated-trailer
// commits SDD implementers demonstrably write (the auth-plan cluster).
//
// TRAILER_TAIL is plain string source, not a RegExp object, because it has to
// serve two different regex engines: git's `--extended-regexp` (POSIX ERE,
// fed as a string) and a native JS RegExp (built from a string via `new
// RegExp(...)`). The syntax here — `[ \t]` as a character class, `\(`/`\)` for
// literal parens, a bare `(...)` group made optional with `?` — parses
// identically in both dialects, so one string literal is a legitimate shared
// source rather than a lucky coincidence: no metacharacter used here differs
// in meaning between POSIX ERE and JS regex syntax.
const TRAILER_TAIL = '[ \\t]*(\\([^)]*\\))?[ \\t]*$';

/**
 * Build the git `--extended-regexp` pattern that matches a `Plan: <path>`
 * trailer line for a SPECIFIC, already-known plan path (used by the
 * derivation grep). `escapedPath` must already have ERE metacharacters
 * escaped by the caller — this function only supplies the shared prefix and
 * tail, it doesn't know how to escape an arbitrary path.
 */
export function trailerGrepPattern(escapedPath) {
  return `^plan:[ \\t]+${escapedPath}${TRAILER_TAIL}`;
}

/**
 * The JS RegExp that discovers an UNKNOWN `Plan: <path>` trailer's path from
 * a raw commit-message line (used by the post-commit hook, which doesn't know
 * in advance which plan(s) a commit's trailers name). Case-insensitive.
 *
 * The capture group is `\S+`, not `\S.*?` (its pre-fix shape) — a plan path is
 * always a single whitespace-free token, so requiring that lets a bareword,
 * non-path suffix (`plan: mark something shipped`, the audit's real
 * false-positive shape — a commit subject that merely starts with the literal
 * string "plan: ") fail to match AT ALL, the same hard rejection the
 * derivation side's guard already gives a bareword suffix, rather than
 * matching a bogus "path" and relying on a downstream fs.existsSync miss as
 * the only backstop.
 */
export const TRAILER_LINE_RE = new RegExp(`^plan:[ \\t]+(\\S+)${TRAILER_TAIL}`, 'i');
