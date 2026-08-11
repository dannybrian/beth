// .claude/skills/plans/lib/trailer.test.mjs
//
// Guards on the commit-message trailer stamp. Every test here exists because
// the unguarded hook mis-attributed real commits: it stamped whichever plan the
// terminal's session record named, no matter how stale that record was, no
// matter whether the id could even identify one terminal, and with no way to
// opt a single commit out.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { trailerDecision } from './trailer.mjs';
import { cleanEnv } from './testEnv.mjs';

const NOW = new Date('2026-07-30T12:00:00Z').getTime();
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();

const liveRecord = (over = {}) => ({
  session_id: 'term-w0t1p0:ABC',
  plan_path: 'plans/2026-07-30-thing.md',
  last_heartbeat: hoursAgo(0.1),
  ...over,
});

// ─── the happy path must survive every guard ──────────────────────────────

test('a fresh claim under a stable session id stamps its plan', () => {
  const d = trailerDecision({ source: '', record: liveRecord(), env: {}, now: NOW });
  assert.equal(d.stamp, true);
  assert.equal(d.planPath, 'plans/2026-07-30-thing.md');
});

test('the ordinary commit sources all stamp', () => {
  for (const source of ['', 'message', 'template']) {
    assert.equal(
      trailerDecision({ source, record: liveRecord(), env: {}, now: NOW }).stamp,
      true,
      `source ${JSON.stringify(source)} must still stamp`,
    );
  }
});

// ─── source skips (pre-existing behaviour, moved here) ────────────────────
// MUTANT: drop the `source === 'merge' || …` branch → these three go red.

test('merge, squash and amend never stamp', () => {
  for (const source of ['merge', 'squash', 'commit']) {
    const d = trailerDecision({ source, record: liveRecord(), env: {}, now: NOW });
    assert.equal(d.stamp, false, `source ${source} must not stamp`);
    assert.equal(d.reason, 'source-skipped');
  }
});

test('no claim at all means nothing to stamp', () => {
  const d = trailerDecision({ source: '', record: null, env: {}, now: NOW });
  assert.equal(d.stamp, false);
  assert.equal(d.reason, 'no-claim');
});

// ─── A1. fallback ids are collision-prone ─────────────────────────────────
// A `fallback-<hash>` id is sha1(tty + ':' + cwd): every terminal without
// session env in one directory resolves to the SAME id, so the record it reads
// may belong to another terminal entirely. Stamping from one is a coin flip.
// MUTANT: delete the isAmbiguousSessionId check → red.

test('a fallback session id never stamps — it cannot identify one terminal', () => {
  const d = trailerDecision({
    source: '',
    record: liveRecord({ session_id: 'fallback-1a2b3c4d' }),
    env: {},
    now: NOW,
  });
  assert.equal(d.stamp, false);
  assert.equal(d.reason, 'ambiguous-session');
});

// ─── A2. stale claims are nobody's active work ────────────────────────────
// 4h is the same threshold the board renders as [stale] and `prune` clears.
// MUTANT: delete the heartbeat-age check → the first two go red.

test('a claim whose heartbeat is older than 4h does not stamp', () => {
  const d = trailerDecision({
    source: '', record: liveRecord({ last_heartbeat: hoursAgo(9) }), env: {}, now: NOW,
  });
  assert.equal(d.stamp, false);
  assert.equal(d.reason, 'stale-claim');
});

test('a record with no heartbeat at all counts as stale', () => {
  const d = trailerDecision({
    source: '', record: liveRecord({ last_heartbeat: null }), env: {}, now: NOW,
  });
  assert.equal(d.stamp, false);
  assert.equal(d.reason, 'stale-claim');
});

test('a claim just inside the 4h window still stamps', () => {
  const d = trailerDecision({
    source: '', record: liveRecord({ last_heartbeat: hoursAgo(3.9) }), env: {}, now: NOW,
  });
  assert.equal(d.stamp, true, 'the guard must not shorten the working window');
});

// ─── A3. the documented per-commit opt-out ────────────────────────────────
// A terminal legitimately holding a claim still makes unrelated commits (the
// director's own recording commits). Before this, the only escape was a
// release / commit / re-claim dance.
// MUTANT: delete the PLANS_NO_TRAILER check → the first two go red.

test('PLANS_NO_TRAILER=1 suppresses the trailer for this commit', () => {
  const d = trailerDecision({
    source: '', record: liveRecord(), env: { PLANS_NO_TRAILER: '1' }, now: NOW,
  });
  assert.equal(d.stamp, false);
  assert.equal(d.reason, 'opted-out');
});

test('PLANS_NO_TRAILER=true is honoured too', () => {
  const d = trailerDecision({
    source: '', record: liveRecord(), env: { PLANS_NO_TRAILER: 'true' }, now: NOW,
  });
  assert.equal(d.stamp, false);
});

test('PLANS_NO_TRAILER=0 is not an opt-out', () => {
  const d = trailerDecision({
    source: '', record: liveRecord(), env: { PLANS_NO_TRAILER: '0' }, now: NOW,
  });
  assert.equal(d.stamp, true, 'only an affirmative value opts out');
});

// ─── wiring: the decision must actually reach the hook path ───────────────
//
// The pure tests above pass just as happily when trailerDecision exists and
// cmdTrailer ignores it. These drive the real `index.mjs trailer` entry point
// the way .claude/githooks/prepare-commit-msg does. They only ever write the
// temp message file we hand them (plus, in the second test, one gitignored
// session record they clean up) — no plan file, no INDEX, no git state.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, '..', 'index.mjs');
const REPO = path.resolve(HERE, '../../../..');
const SESSIONS = path.join(REPO, '.claude', 'sessions');

// cleanEnv, not {...process.env}: this suite runs from the pre-commit hook, and
// the documented way to commit unrelated work is `PLANS_NO_TRAILER=1 git commit`
// — which used to reach these children and fail the must-stamp case below.
function runTrailer(msgFile, env) {
  execFileSync(process.execPath, [INDEX, 'trailer', msgFile, ''], {
    cwd: REPO,
    env: cleanEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return fs.readFileSync(msgFile, 'utf8');
}

function withTempMessage(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-trailer-'));
  const file = path.join(dir, 'COMMIT_EDITMSG');
  fs.writeFileSync(file, 'chore: a commit\n');
  try { return fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// MUTANT: have cmdTrailer ignore trailerDecision's opted-out reason → red.
test('the hook entry point honours PLANS_NO_TRAILER regardless of any live claim', () => {
  const out = withTempMessage((file) => runTrailer(file, { PLANS_NO_TRAILER: '1' }));
  assert.equal(out, 'chore: a commit\n', 'an opted-out commit message must be untouched');
});

// Fabricate a session record under an id only this test uses, so the assertion
// does not depend on whatever the running terminal happens to have claimed.
function withFakeSession(record, fn) {
  fs.mkdirSync(SESSIONS, { recursive: true });
  const file = path.join(SESSIONS, `term-${record.termId}.json`);
  fs.writeFileSync(file, JSON.stringify({
    session_id: `term-${record.termId}`,
    plan_path: record.plan_path,
    branch: 'main',
    last_heartbeat: record.last_heartbeat,
  }, null, 2) + '\n');
  try { return fn(record.termId); } finally { fs.rmSync(file, { force: true }); }
}

// MUTANT: drop the staleness check inside cmdTrailer's decision → red.
test('the hook entry point stamps a live claim and skips a stale one', () => {
  const plan = 'plans/2026-07-30-trailer-wiring-fixture.md';
  const live = withFakeSession(
    { termId: `plans-test-live-${process.pid}`, plan_path: plan, last_heartbeat: new Date().toISOString() },
    (termId) => withTempMessage((f) => runTrailer(f, { TERM_SESSION_ID: termId })),
  );
  assert.match(live, /^Plan: plans\/2026-07-30-trailer-wiring-fixture\.md$/m,
    'a live claim must still be stamped');

  const stale = withFakeSession(
    {
      termId: `plans-test-stale-${process.pid}`,
      plan_path: plan,
      last_heartbeat: new Date(Date.now() - 9 * 3_600_000).toISOString(),
    },
    (termId) => withTempMessage((f) => runTrailer(f, { TERM_SESSION_ID: termId })),
  );
  assert.equal(stale, 'chore: a commit\n', 'a 9h-old claim must not be stamped');
});

// THE REGRESSION, pinned inside the suite rather than only in a shell recipe.
// `PLANS_NO_TRAILER=1 git commit …` runs the pre-commit hook, which runs this
// suite, which spawned children inheriting that var — so the must-stamp test
// above failed and aborted a commit that was correct. The env a test asserts
// against has to be the env it states.
// MUTANT: go back to `{...process.env, ...env}` in runTrailer → red.
test('an ambient PLANS_NO_TRAILER in the runner does not change what fixtures observe', () => {
  const before = process.env.PLANS_NO_TRAILER;
  process.env.PLANS_NO_TRAILER = '1'; // simulate being invoked by that commit
  try {
    const out = withFakeSession(
      {
        termId: `plans-test-ambient-${process.pid}`,
        plan_path: 'plans/2026-07-30-trailer-wiring-fixture.md',
        last_heartbeat: new Date().toISOString(),
      },
      (termId) => withTempMessage((f) => runTrailer(f, { TERM_SESSION_ID: termId })),
    );
    assert.match(out, /^Plan: plans\/2026-07-30-trailer-wiring-fixture\.md$/m,
      'the fixture states no opt-out, so it must stamp regardless of the shell');
  } finally {
    if (before === undefined) delete process.env.PLANS_NO_TRAILER;
    else process.env.PLANS_NO_TRAILER = before;
  }
});
