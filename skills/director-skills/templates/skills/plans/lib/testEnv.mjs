// .claude/skills/plans/lib/testEnv.mjs
//
// Environment plumbing for the tests that spawn index.mjs (or git) as a child.
//
// Why this exists: the pre-commit hook runs this suite as a child process, so
// the suite inherits the shell that invoked git — and worse, it inherits what
// GIT ITSELF exports to its hooks. Two real aborted commits taught us that:
//
//   1. `PLANS_NO_TRAILER=1 git commit …` (the documented opt-out) reached the
//      fixtures, and the "a live claim must still be stamped" test saw its
//      child decline to stamp.
//   2. A PATHSPEC commit (`git commit -m … -- <files>`) exports GIT_INDEX_FILE
//      as an ABSOLUTE path to the outer repo's temporary index
//      (`.git/next-index-<pid>.lock`). Fixture git ops that inherit it operate
//      against an index whose entries name objects that exist only in the
//      outer repo, and die with `error: invalid object 100755 …`. (A plain
//      commit exports the RELATIVE `.git/index`, which resolves inside the
//      fixture's cwd — accidentally harmless, which is why this hid until the
//      first pathspec landing commit.)
//
// A test's outcome must depend on the environment it STATES, never on the one
// it happens to run in. Same discipline as the fixtures pinning core.hooksPath.
//
// Both strips are by PREFIX, not by a list of known names: the PLANS_ knob set
// is ours and grows, and git's hook-exported set has grown across versions
// (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_PREFIX, GIT_OBJECT_DIRECTORY,
// GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_COMMON_DIR, GIT_AUTHOR_*, GIT_EDITOR,
// GIT_EXEC_PATH, …) — an explicit list is stale the day either grows. Anything
// a fixture genuinely needs (the GIT_AUTHOR_NAME identity, an opt-out under
// test) is an override, applied AFTER the strip, so stated env always wins.
// git resolves its own exec path when GIT_EXEC_PATH is absent, so the blanket
// strip costs nothing.

/** Every knob the skill reads from the environment shares this prefix. */
export const PLANS_ENV_PREFIX = 'PLANS_';

/** git's repo-context/hook-exported vars all share this prefix too. */
export const GIT_ENV_PREFIX = 'GIT_';

/**
 * Build a child environment with the inherited PLANS_* and GIT_* vars
 * stripped, then the caller's explicit overrides applied on top.
 *
 * Overrides win: an opt-out test still says `{PLANS_NO_TRAILER: '1'}` and the
 * git fixtures still say `{GIT_AUTHOR_NAME: 'Fixture'}` — the point is that
 * they have to say so.
 */
export function cleanEnv(overrides = {}, base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith(PLANS_ENV_PREFIX) || k.startsWith(GIT_ENV_PREFIX)) continue;
    env[k] = v;
  }
  return { ...env, ...overrides };
}
