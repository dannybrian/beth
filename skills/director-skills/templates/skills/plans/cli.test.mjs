// .claude/skills/plans/cli.test.mjs
//
// End-to-end tests for index.mjs, driven against a THROWAWAY git repo built in
// a temp dir. Nothing here touches the real beadgame repo: the skill finds its
// root by walking up from cwd for CLAUDE.md + .git, so a fixture repo with both
// is a complete, isolated world. That isolation is the point — a `commits
// --sync` or full `index` run against the real tree would rewrite hand-repaired
// `commits:` lists from the very polluted trailers this work exists to defuse.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanEnv } from './lib/testEnv.mjs';

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function git(repo, args) {
  return execFileSync('git', args, {
    cwd: repo,
    // cleanEnv even here: fixture commits must behave the same whether or not
    // the invoking shell exported a PLANS_* knob (see lib/testEnv.mjs).
    env: cleanEnv({
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

/** A minimal repo the /plans skill will accept as its root. */
function makeRepo() {
  // realpathSync: on macOS the temp dir is /var/… → /private/var/…, and the
  // skill compares resolved paths.
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plans-cli-')));
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# fixture repo\n');
  fs.mkdirSync(path.join(repo, 'plans'), { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  // core.hooksPath is set GLOBALLY on this machine (to the real repo's hooks),
  // so a fresh `git init` elsewhere still inherits our prepare-commit-msg /
  // post-commit / pre-commit. They resolve their repo root from cwd and find no
  // skill in the fixture, so they no-op — but "happens to no-op" is not a
  // property to build tests on: an empty hooks dir makes each fixture commit
  // hermetic, and stops any future hook from racing the assertions.
  const hooks = path.join(repo, '.empty-hooks');
  fs.mkdirSync(hooks, { recursive: true });
  git(repo, ['config', 'core.hooksPath', hooks]);
  return repo;
}

/** Write a plan file with the given frontmatter lines (already formatted). */
function writePlan(repo, rel, frontmatterLines, title = 'Fixture Plan') {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, ['---', ...frontmatterLines, '---', '', `# ${title}`, '', '## Context', '', 'Fixture.', ''].join('\n'));
  return abs;
}

/** Commit an empty-ish change, optionally carrying a `Plan:` trailer. */
function commit(repo, subject, planTrailer = null) {
  fs.appendFileSync(path.join(repo, 'CLAUDE.md'), `\n${subject}\n`);
  git(repo, ['add', 'CLAUDE.md']);
  const msg = planTrailer ? `${subject}\n\nPlan: ${planTrailer}\n` : `${subject}\n`;
  git(repo, ['commit', '-q', '-m', msg]);
  return git(repo, ['rev-parse', '--short', 'HEAD']).trim();
}

/**
 * Short shas as the SKILL will see them, read at assertion time.
 *
 * git's abbreviation length is adaptive — it can grow as the repo does — so a
 * sha captured right after its own commit is not guaranteed to be spelled the
 * same way in a `git log` run three commits later. Comparing skill output
 * against values read now removes that as a source of intermittent failure.
 * (The exclusion entries stay as captured, which is the point: they exercise
 * the cross-length matching on purpose.)
 */
function shortShas(repo) {
  return git(repo, ['log', '--pretty=format:%h', '--reverse']).split('\n').map(s => s.trim()).filter(Boolean);
}

function runSkill(repo, args, { env = {}, bareEnv = false, expectFail = false } = {}) {
  const childEnv = bareEnv
    // Deliberately session-env-free: no TERM_SESSION_ID / ITERM_SESSION_ID /
    // CLAUDE*_SESSION_ID, and stdio is piped so `tty` yields '' — exactly the
    // conditions that produce a collision-prone `fallback-<hash>` id.
    ? cleanEnv({ HOME: repo, ...env }, { PATH: process.env.PATH })
    : cleanEnv(env);
  try {
    const stdout = execFileSync(process.execPath, [INDEX, ...args], {
      cwd: repo, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    if (expectFail) assert.fail(`expected failure, got success:\n${stdout}`);
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    if (!expectFail) assert.fail(`unexpected failure: ${e.stderr?.toString() || e.message}`);
    return { code: e.status, stdout: e.stdout?.toString() || '', stderr: e.stderr?.toString() || '' };
  }
}

function readFrontmatter(absPath) {
  const lines = fs.readFileSync(absPath, 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  const meta = {};
  for (const l of lines.slice(1, end)) {
    const m = l.match(/^([a-zA-Z_][\w]*):\s*(.*)$/);
    if (m) meta[m[1]] = m[2];
  }
  return meta;
}

const FM = (extra = []) => ['status: active', 'owner: null', 'last_touched: 2026-07-30', ...extra];

// ─── B. commits_exclude ───────────────────────────────────────────────────
// Trailers in git history are immutable. When one is wrong — and dozens are,
// from the stale-claim stamping this same change fixes — the derived list must
// still be able to tell the truth, durably: a hand-repaired `commits:` list is
// blown away by the very next sync, but an exclusion is re-applied by every one.
// MUTANT: drop the filterExcludedCommits call in commitsForPlan → red.

test('commits --sync drops excluded shas and preserves the exclusion list', () => {
  const repo = makeRepo();
  try {
    const rel = 'plans/2026-07-30-fixture.md';
    const abs = writePlan(repo, rel, FM());
    commit(repo, 'first', rel);
    const b = commit(repo, 'second (misattributed)', rel);
    commit(repo, 'third', rel);

    // The operator records the bad one, exactly as plans/README documents.
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8')
      .replace('last_touched: 2026-07-30', `last_touched: 2026-07-30\ncommits_exclude: [${b}]`));

    runSkill(repo, ['commits', rel, '--sync']);

    const [a, , c] = shortShas(repo);
    const meta = readFrontmatter(abs);
    assert.equal(meta.commits, `[${a}, ${c}]`, 'the misattributed sha must be filtered out');
    assert.equal(meta.commits_exclude, `[${b}]`, 'sync must preserve the exclusion itself');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// The post-commit hook and a full `index` regen are separate sync paths; the
// filter has to sit where all three share it.
// MUTANT: apply the filter only inside syncCommitsForPlan's caller → red here.
test('a full index regen and the post-commit path both honour commits_exclude', () => {
  const repo = makeRepo();
  try {
    const rel = 'plans/2026-07-30-fixture.md';
    const abs = writePlan(repo, rel, FM());
    commit(repo, 'first', rel);
    const b = commit(repo, 'second (misattributed)', rel);
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8')
      .replace('last_touched: 2026-07-30', `last_touched: 2026-07-30\ncommits_exclude: [${b}]`));

    runSkill(repo, ['index']);
    const [a] = shortShas(repo);
    const idx = JSON.parse(fs.readFileSync(path.join(repo, 'plans', 'INDEX.json'), 'utf8'));
    const entry = idx.plans.find((p) => p.path === rel);
    assert.deepEqual(entry.commits, [a], 'INDEX must not carry an excluded sha');
    assert.equal(idx.plan_count, 1, 'INDEX regen must not choke on the new field');

    // post-commit re-derives from HEAD's trailer — the same exclusion applies.
    commit(repo, 'third', rel);
    runSkill(repo, ['post-commit']);
    assert.equal(readFrontmatter(abs).commits.includes(b), false,
      'the post-commit sync must not reintroduce an excluded sha');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// Plain `commits <plan>` is the command an operator runs to CHECK that an
// exclusion took — so it is the one place the excluded sha must not appear.
// It used the filtered list only for the empty-state message and then printed a
// second, raw `git log`.
// MUTANT: print the raw log lines instead of the filtered ones → red.
test('plain commits (no --sync) also hides excluded shas, with subjects intact', () => {
  const repo = makeRepo();
  try {
    const rel = 'plans/2026-07-30-fixture.md';
    const abs = writePlan(repo, rel, FM());
    commit(repo, 'first', rel);
    const b = commit(repo, 'second (misattributed)', rel);
    commit(repo, 'third', rel);
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8')
      .replace('last_touched: 2026-07-30', `last_touched: 2026-07-30\ncommits_exclude: [${b}]`));

    const { stdout } = runSkill(repo, ['commits', rel]);
    assert.equal(stdout.includes(b), false, `the excluded sha ${b} must not be listed`);
    assert.equal(stdout.includes('second (misattributed)'), false,
      'nor its subject line');
    assert.match(stdout, /first/, 'the kept commits still print');
    assert.match(stdout, /third/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// The whole list excluded is not "no trailer exists" — but from the operator's
// side both mean "this plan claims nothing", so the empty-state message stands.
test('excluding every commit leaves the plain listing empty rather than raw', () => {
  const repo = makeRepo();
  try {
    const rel = 'plans/2026-07-30-fixture.md';
    const abs = writePlan(repo, rel, FM());
    const a = commit(repo, 'only', rel);
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8')
      .replace('last_touched: 2026-07-30', `last_touched: 2026-07-30\ncommits_exclude: [${a}]`));

    const { stdout } = runSkill(repo, ['commits', rel]);
    assert.equal(stdout.includes(a), false);
    assert.match(stdout, /no commits/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// ─── commits_include ───────────────────────────────────────────────────────
// The missing half of the linkage-repair mechanism: several plans' HONEST
// commit sets contain shas that carry only ANOTHER plan's trailer (or none at
// all) in immutable history — a trailer-derived sync can never reproduce them.
// `commits_include:` names those shas by hand; every sync path (the same
// single funnel commits_exclude uses) must merge them in.
// MUTANT: drop the mergeIncludedCommits call in commitsForPlan → red.

test('commits --sync merges an included sha with no trailer at all, and preserves the include list', () => {
  const repo = makeRepo();
  try {
    const rel = 'plans/2026-07-30-fixture.md';
    const abs = writePlan(repo, rel, FM());
    commit(repo, 'first', rel);
    // No Plan: trailer at all — this is the untrailered-history case.
    const untrailered = commit(repo, 'untrailered work that actually belongs here');
    commit(repo, 'third', rel);

    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8')
      .replace('last_touched: 2026-07-30', `last_touched: 2026-07-30\ncommits_include: [${untrailered}]`));

    runSkill(repo, ['commits', rel, '--sync']);

    const [a, , c] = shortShas(repo);
    const meta = readFrontmatter(abs);
    assert.equal(meta.commits, `[${a}, ${c}, ${untrailered}]`,
      'the included sha must be appended after the trailer-derived ones');
    assert.equal(meta.commits_include, `[${untrailered}]`, 'sync must preserve the include list itself');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('commits --sync merges an included sha that carries ANOTHER plan\'s trailer', () => {
  const repo = makeRepo();
  try {
    const relA = 'plans/2026-07-30-plan-a.md';
    const relB = 'plans/2026-07-30-plan-b.md';
    writePlan(repo, relA, FM(), 'Plan A');
    const absB = writePlan(repo, relB, FM(), 'Plan B');
    // Stamped for plan A, but honestly belongs to plan B's history too.
    const misattributed = commit(repo, 'work that also belongs to B', relA);

    fs.writeFileSync(absB, fs.readFileSync(absB, 'utf8')
      .replace('last_touched: 2026-07-30', `last_touched: 2026-07-30\ncommits_include: [${misattributed}]`));

    runSkill(repo, ['commits', relB, '--sync']);

    const meta = readFrontmatter(absB);
    assert.equal(meta.commits, `[${misattributed}]`,
      'plan B must be able to claim a commit whose trailer names plan A');
    // Plan A keeps it too — commits_include never removes a sha from anywhere else.
    const metaA = readFrontmatter(path.join(repo, relA));
    assert.equal(metaA.commits, undefined, 'plan A was never synced in this test, so its field is untouched');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('exclude wins when a sha is named in both commits_include and commits_exclude', () => {
  const repo = makeRepo();
  try {
    const rel = 'plans/2026-07-30-fixture.md';
    const abs = writePlan(repo, rel, FM());
    const untrailered = commit(repo, 'untrailered, then disowned again');

    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8')
      .replace('last_touched: 2026-07-30',
        `last_touched: 2026-07-30\ncommits_include: [${untrailered}]\ncommits_exclude: [${untrailered}]`));

    runSkill(repo, ['commits', rel, '--sync']);

    const meta = readFrontmatter(abs);
    assert.equal(meta.commits, undefined, 'a sha in both fields must not survive — exclude wins');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// The post-commit hook and a full `index` regen are separate sync paths; the
// merge has to sit where all three share it, same as the exclude filter does.
// MUTANT: apply the merge only inside syncCommitsForPlan's caller → red here.
test('a full index regen and the post-commit path both honour commits_include', () => {
  const repo = makeRepo();
  try {
    const rel = 'plans/2026-07-30-fixture.md';
    const abs = writePlan(repo, rel, FM());
    const untrailered = commit(repo, 'untrailered work');
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8')
      .replace('last_touched: 2026-07-30', `last_touched: 2026-07-30\ncommits_include: [${untrailered}]`));

    runSkill(repo, ['index']);
    const idx = JSON.parse(fs.readFileSync(path.join(repo, 'plans', 'INDEX.json'), 'utf8'));
    const entry = idx.plans.find((p) => p.path === rel);
    assert.deepEqual(entry.commits, [untrailered], 'INDEX must carry the included sha');

    // post-commit re-derives from HEAD's trailer — the include must still apply
    // even when HEAD itself isn't the included commit.
    commit(repo, 'fourth', rel);
    runSkill(repo, ['post-commit']);
    assert.equal(readFrontmatter(abs).commits.includes(untrailered), true,
      'the post-commit sync must not drop the included sha');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// Plain `commits <plan>` is the command an operator runs to CHECK linkage —
// it must show an included sha with its real subject, even though that
// commit carries no trailer for this plan at all (so the old trailer-grep
// display path finds no subject line for it whatsoever).
// MUTANT: revert the display to the trailer-grep-only subject lookup → red.
test('plain commits (no --sync) shows an included, untrailered sha with its subject', () => {
  const repo = makeRepo();
  try {
    const rel = 'plans/2026-07-30-fixture.md';
    const abs = writePlan(repo, rel, FM());
    commit(repo, 'first', rel);
    const untrailered = commit(repo, 'untrailered but honestly ours');
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8')
      .replace('last_touched: 2026-07-30', `last_touched: 2026-07-30\ncommits_include: [${untrailered}]`));

    const { stdout } = runSkill(repo, ['commits', rel]);
    assert.match(stdout, /first/, 'the trailer-derived commit still prints');
    assert.match(stdout, /untrailered but honestly ours/,
      'the included commit\'s real subject must print even without a trailer match');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// ─── a git-log failure during derivation must not wipe commits_include ────
// `commitsForPlan`'s trailer-grep `git log` call is wrapped in try/catch; on
// failure the ORIGINAL code did `return []` immediately — short-circuiting
// past the merge/filter step entirely, so even a plan with an explicit
// `commits_include:` entry (which needs no git-log success at all) would sync
// to an EMPTY `commits:` field, wiping the operator's repair. The fix falls
// through to `derived = []` and still runs merge + filter, so includes survive
// a git failure and excludes still apply.
//
// Forced by renaming `.git/HEAD` out from under the fixture repo — `git log`
// then fails with "fatal: not a git repository" (verified: exit 128), which is
// exactly the kind of failure the try/catch guards against. Restored in a
// `finally` before the repo is torn down, so a mid-test crash never leaves a
// corrupted fixture on disk (moot here since fixtures are temp dirs, but
// matches the discipline of never leaving a real git repo half-broken).
// MUTANT: revert the catch body to `return [];` → this test reds.
test('a git-log failure during derivation still merges commits_include and keeps commits_exclude dropped', () => {
  const repo = makeRepo();
  try {
    const rel = 'plans/2026-07-30-fixture.md';
    const abs = writePlan(repo, rel, FM());
    commit(repo, 'first', rel); // would derive normally — but git log is about to be broken
    const included = commit(repo, 'untrailered but honestly ours');
    const excluded = commit(repo, 'to be excluded');
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8')
      .replace('last_touched: 2026-07-30',
        `last_touched: 2026-07-30\ncommits_include: [${included}]\ncommits_exclude: [${excluded}]`));

    const headPath = path.join(repo, '.git', 'HEAD');
    const headBak = headPath + '.bak';
    fs.renameSync(headPath, headBak);
    try {
      runSkill(repo, ['commits', rel, '--sync']);
    } finally {
      fs.renameSync(headBak, headPath);
    }

    const meta = readFrontmatter(abs);
    assert.equal(meta.commits, `[${included}]`,
      'a derivation failure must not wipe the included sha, and the excluded one must stay dropped');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// ─── trailer-derivation regex tolerates a trailing parenthetical annotation ─
// Audit-found: real trailers written as `Plan: <path> (Task N)` failed the
// strict `^plan:[ \t]+<path>[ \t]*$` anchor — the entire auth-plan cluster
// derived to ZERO commits because of it, real trailers with honest
// attribution, simply unmatched. Loosened to accept exactly one trailing
// `(...)` group after the path.
// MUTANT: revert the pattern to the strict anchor → this test reds.
test('a trailer with a trailing parenthetical annotation still derives', () => {
  const repo = makeRepo();
  try {
    const rel = 'plans/2026-07-30-fixture.md';
    writePlan(repo, rel, FM());
    fs.appendFileSync(path.join(repo, 'CLAUDE.md'), '\nannotated\n');
    git(repo, ['add', 'CLAUDE.md']);
    git(repo, ['commit', '-q', '-m', `feat: task 1\n\nPlan: ${rel} (Task 1)\n`]);
    const sha = git(repo, ['rev-parse', '--short', 'HEAD']).trim();

    const { stdout } = runSkill(repo, ['commits', rel]);
    assert.match(stdout, new RegExp(sha), 'the annotated trailer must still derive');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// Guard against over-loosening: the fix must accept ONE parenthetical, not
// degrade into "starts with the path". A commit whose message begins
// `plan: <path> <bare extra words>` (no parens — the audit's real example was
// a plain-prose subject like `ff4b8840 "plan: mark
// public-deployment-security-hardening shipped"`) must still not match.
// MUTANT: loosen the trailing anchor to `[ \t]+.*$` (any trailing text, not
// just one parenthetical) → this test reds while the annotation test above
// stays green — proving the two tests pin different, adjacent boundaries.
test('a bare-word suffix after the path (not parenthesized) still does not derive', () => {
  const repo = makeRepo();
  try {
    const rel = 'plans/2026-07-30-fixture.md';
    writePlan(repo, rel, FM());
    fs.appendFileSync(path.join(repo, 'CLAUDE.md'), '\nbareword\n');
    git(repo, ['add', 'CLAUDE.md']);
    git(repo, ['commit', '-q', '-m', `plan: ${rel} shipped\n`]);

    const { stdout } = runSkill(repo, ['commits', rel]);
    assert.match(stdout, /no commits/, 'bare trailing prose after the path must not derive');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// ─── one shared trailer definition, two consumers ──────────────────────────
// `commitsForPlan`'s derivation grep and `cmdPostCommit`'s path-extraction
// regex are two independent answers to "what counts as a Plan: trailer" living
// in the same file. Round 1 fixed only the derivation side to tolerate
// `(Task N)`; `cmdPostCommit`'s extraction kept the strict tail, so the
// INCREMENTAL post-commit sync would silently no-op for exactly the
// annotated-trailer commits this feature exists to handle (SDD implementers
// demonstrably write `(Task N)` trailers — the auth cluster is real). Both
// consumers now read from one shared definition (lib/commits.mjs) so they
// cannot drift again.
// MUTANT: revert cmdPostCommit to its own inline `/^plan:[ \t]+(\S.*?)[ \t]*$/i`
// → the first test here reds.

test('post-commit triggers the incremental sync for a trailer with a parenthetical annotation', () => {
  const repo = makeRepo();
  try {
    const rel = 'plans/2026-07-30-fixture.md';
    const abs = writePlan(repo, rel, FM());
    commit(repo, 'bootstrap'); // plan file exists in history before the annotated commit
    fs.appendFileSync(path.join(repo, 'CLAUDE.md'), '\nannotated task\n');
    git(repo, ['add', 'CLAUDE.md']);
    git(repo, ['commit', '-q', '-m', `feat: task 2\n\nPlan: ${rel} (Task 2)\n`]);
    const sha = git(repo, ['rev-parse', '--short', 'HEAD']).trim();

    runSkill(repo, ['post-commit']);

    const meta = readFrontmatter(abs);
    assert.equal(meta.commits, `[${sha}]`,
      'the post-commit incremental sync must fire for an annotated trailer, not silently no-op');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// The round-1 false-positive guard, re-proven for the extraction consumer: a
// commit whose SUBJECT merely starts with the literal string "plan: " and
// happens to contain no real path (prose, not a trailer) must not trigger any
// sync — extraction must fail to match it at all, the same way derivation
// does, rather than relying on a downstream fs.existsSync miss as the only
// backstop.
test('post-commit ignores a bare-prose subject that starts with "plan: " but names no real path', () => {
  const repo = makeRepo();
  try {
    const rel = 'plans/2026-07-30-fixture.md';
    const abs = writePlan(repo, rel, FM());
    commit(repo, 'bootstrap');
    fs.appendFileSync(path.join(repo, 'CLAUDE.md'), '\nprose subject\n');
    git(repo, ['add', 'CLAUDE.md']);
    // Shaped after the audit's real example: `ff4b8840 "plan: mark
    // public-deployment-security-hardening shipped"` — no colon-path, just prose.
    git(repo, ['commit', '-q', '-m', 'plan: mark something shipped\n']);

    const before = readFrontmatter(abs).commits;
    runSkill(repo, ['post-commit']);
    const after = readFrontmatter(abs).commits;
    assert.equal(after, before, 'a bare-prose "plan: " subject must not trigger any sync at all');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// ─── D. all-digit short shas are strings in INDEX.json ────────────────────
// Our frontmatter parser coerces /^-?\d+$/ to a number, so `commits:
// [44002735]` reached INDEX.json as the number 44002735 — unusable as a sha by
// any consumer. This runs `claim`, whose INDEX regen deliberately skips the git
// sync, so the value under test is the one parsed off the plan file.
// MUTANT: revert summarize()'s normalizeShaList to a bare Array.isArray pass → red.

// The flake's root cause, pinned deterministically: no brute-forcing a real
// commit into this shape, just the value that shape produces. Before the
// sha-list parser, `commits:` came back as the number 49719 and
// `commits_exclude:` was REWRITTEN mangled — corrupting the operator's own
// repair on the first sync that touched the plan.
// MUTANT: route sha keys back through parseYamlValue → both tests red.
test('a leading-zero sha is not mangled on the way into INDEX.json', () => {
  const repo = makeRepo();
  try {
    const rel = 'plans/2026-07-30-leading-zero.md';
    writePlan(repo, rel, FM(['commits: [0049719, 0044002]']));
    commit(repo, 'bootstrap');

    runSkill(repo, ['claim', rel], { env: { TERM_SESSION_ID: 'fixture-tab' } });

    const idx = JSON.parse(fs.readFileSync(path.join(repo, 'plans', 'INDEX.json'), 'utf8'));
    const entry = idx.plans.find((p) => p.path === rel);
    assert.deepEqual(entry.commits, ['0049719', '0044002'],
      'a sha git can resolve must survive the round trip');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('a sync preserves a leading-zero commits_exclude entry verbatim', () => {
  const repo = makeRepo();
  try {
    const rel = 'plans/2026-07-30-leading-zero.md';
    const abs = writePlan(repo, rel, FM(['commits_exclude: [0049719]']));
    commit(repo, 'first', rel);

    runSkill(repo, ['commits', rel, '--sync']);

    assert.equal(readFrontmatter(abs).commits_exclude, '[0049719]',
      'the exclusion must still name the commit it was written for');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('an all-digit short sha reaches INDEX.json as a string', () => {
  const repo = makeRepo();
  try {
    const rel = 'plans/2026-07-30-digits.md';
    writePlan(repo, rel, FM(['commits: [44002735, a1b2c3d4]']));
    commit(repo, 'bootstrap');

    runSkill(repo, ['claim', rel], { env: { TERM_SESSION_ID: 'fixture-tab' } });

    const idx = JSON.parse(fs.readFileSync(path.join(repo, 'plans', 'INDEX.json'), 'utf8'));
    const entry = idx.plans.find((p) => p.path === rel);
    assert.deepEqual(entry.commits, ['44002735', 'a1b2c3d4']);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// ─── C. lifecycle ops refuse a fallback id ────────────────────────────────
// A `fallback-<hash>` id is shared by every session in one directory, so a
// lifecycle op issued under one acts on whatever that shared record names — on
// 2026-07-30 a release under a colliding fallback id dropped the WRONG
// session's claim (plan unity/164).
// MUTANT: delete the lifecycleGuard call in cmdClaim/cmdStatus/cmdRelease → red.

test('claim, status and release refuse to act under a fallback session id', () => {
  const repo = makeRepo();
  try {
    const rel = 'plans/2026-07-30-fallback.md';
    writePlan(repo, rel, FM());
    commit(repo, 'bootstrap');

    for (const args of [['claim', rel], ['status', 'blocked'], ['release']]) {
      const r = runSkill(repo, args, { bareEnv: true, expectFail: true });
      assert.match(r.stderr, /fallback/i, `${args[0]} must name the fallback id as the reason`);
      assert.match(r.stderr, /--force/, `${args[0]} must say how to override`);
    }
    // Nothing was written: no owner on the plan, no session record.
    assert.equal(readFrontmatter(path.join(repo, rel)).owner, 'null');
    assert.equal(fs.existsSync(path.join(repo, '.claude', 'sessions')), false);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('--force takes the fallback id anyway, so a lone session is never stuck', () => {
  const repo = makeRepo();
  try {
    const rel = 'plans/2026-07-30-fallback.md';
    writePlan(repo, rel, FM());
    commit(repo, 'bootstrap');

    const r = runSkill(repo, ['claim', rel, '--force'], { bareEnv: true });
    assert.match(r.stdout, /claimed/);
    assert.match(readFrontmatter(path.join(repo, rel)).owner, /^fallback-/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// ─── hermeticity against the git hook environment ─────────────────────────
// THE REGRESSION, pinned inside the suite (same pattern as trailer.test.mjs's
// ambient PLANS_NO_TRAILER test). The pre-commit hook runs this suite as a
// child of `git commit`, and for a PATHSPEC commit git exports GIT_INDEX_FILE
// as an ABSOLUTE path to the outer repo's temporary index. Fixture git ops that
// inherit it read/write the OUTER index, whose entries name objects that exist
// only in the outer repo — so the fixture's own `git commit` dies with
// `error: invalid object 100755 …` (on 2026-07-30 that aborted a real landing
// commit; the unfound object was the real repo's .claude/githooks/install.sh).
// MUTANT: cleanEnv strips only PLANS_ (not GIT_) → red.
test('an ambient GIT_INDEX_FILE from a git hook does not reach fixture git ops', () => {
  // An "outer" repo standing in for the real one: its index names objects
  // (including an executable, for the 100755 fidelity) that no fixture repo
  // has. Built BEFORE the ambient var is set, so its own setup git ops are
  // unaffected either way.
  const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plans-outer-')));
  const before = process.env.GIT_INDEX_FILE;
  try {
    git(outer, ['init', '-q', '-b', 'main']);
    git(outer, ['config', 'commit.gpgsign', 'false']);
    const hooks = path.join(outer, '.empty-hooks');
    fs.mkdirSync(hooks, { recursive: true });
    git(outer, ['config', 'core.hooksPath', hooks]);
    fs.writeFileSync(path.join(outer, 'exec.sh'), '#!/bin/sh\necho hi\n');
    fs.chmodSync(path.join(outer, 'exec.sh'), 0o755);
    git(outer, ['add', 'exec.sh']);
    git(outer, ['commit', '-q', '-m', 'seed']);

    // Simulate being spawned by the hook of a pathspec commit in `outer`.
    process.env.GIT_INDEX_FILE = path.join(outer, '.git', 'index');

    const repo = makeRepo();
    try {
      const sha = commit(repo, 'hermetic against the hook environment');
      assert.match(sha, /^[0-9a-f]{4,}$/, 'the fixture commit must succeed');
      assert.match(git(repo, ['log', '--oneline']), /hermetic against the hook environment/,
        'and land in the FIXTURE repo, not the outer index');
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  } finally {
    if (before === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = before;
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('a stable session id is unaffected by the fallback guard', () => {
  const repo = makeRepo();
  try {
    const rel = 'plans/2026-07-30-stable.md';
    writePlan(repo, rel, FM());
    commit(repo, 'bootstrap');

    runSkill(repo, ['claim', rel], { env: { TERM_SESSION_ID: 'fixture-tab' } });
    assert.equal(readFrontmatter(path.join(repo, rel)).owner, 'term-fixture-tab');
    runSkill(repo, ['status', 'blocked'], { env: { TERM_SESSION_ID: 'fixture-tab' } });
    assert.equal(readFrontmatter(path.join(repo, rel)).status, 'blocked');
    runSkill(repo, ['release'], { env: { TERM_SESSION_ID: 'fixture-tab' } });
    assert.equal(readFrontmatter(path.join(repo, rel)).owner, 'null');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
