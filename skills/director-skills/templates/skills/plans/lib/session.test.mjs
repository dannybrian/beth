// .claude/skills/plans/lib/session.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionId, isAmbiguousSessionId, claimDecision, releaseDecision, ownsPlan, normalizePlanPath, lifecycleGuard } from './session.mjs';

const noTty = () => '';

test('a Terminal.app session is keyed by TERM_SESSION_ID', () => {
  assert.equal(
    sessionId({ env: { TERM_SESSION_ID: 'w0t2p0:ABC' }, cwd: '/repo', readTty: noTty }),
    'term-w0t2p0:ABC',
  );
});

test('an iTerm session is keyed by ITERM_SESSION_ID', () => {
  assert.equal(
    sessionId({ env: { ITERM_SESSION_ID: 'w1t0p0:DEF' }, cwd: '/repo', readTty: noTty }),
    'iterm-w1t0p0:DEF',
  );
});

test('TERM_SESSION_ID wins over every less specific source', () => {
  const sid = sessionId({
    env: { TERM_SESSION_ID: 'tab-1', ITERM_SESSION_ID: 'x', CLAUDE_CODE_SESSION_ID: 'y' },
    cwd: '/repo',
    readTty: noTty,
  });
  assert.equal(sid, 'term-tab-1');
});

// THE DEFECT. Two Claude Code desktop conversations in one directory: no
// TERM_SESSION_ID, no tty, only CLAUDE_CODE_SESSION_ID to tell them apart.
// Before the fix both collapse to sha1(':' + cwd) and this fails.
test('two desktop sessions in one directory get distinct ids', () => {
  const a = sessionId({ env: { CLAUDE_CODE_SESSION_ID: 'aaaa-1111' }, cwd: '/repo/game', readTty: noTty });
  const b = sessionId({ env: { CLAUDE_CODE_SESSION_ID: 'bbbb-2222' }, cwd: '/repo/game', readTty: noTty });
  assert.notEqual(a, b, 'desktop sessions in one cwd must not share a /plans identity');
});

// Same unfixed branch as the test above — this one was also red before the fix.
test('a desktop session id is derived from CLAUDE_CODE_SESSION_ID, not hashed', () => {
  const sid = sessionId({ env: { CLAUDE_CODE_SESSION_ID: 'a7717d8a' }, cwd: '/repo', readTty: noTty });
  assert.equal(sid, 'claude-a7717d8a');
  assert.equal(isAmbiguousSessionId(sid), false);
});

// Pinning the remaining weakness honestly: with NO session env at all we still
// fall back to a cwd hash, which is not unique across concurrent sessions.
// Callers that care must check isAmbiguousSessionId.
test('with no session env at all the id is an ambiguous cwd hash', () => {
  const a = sessionId({ env: {}, cwd: '/repo/game', readTty: noTty });
  const b = sessionId({ env: {}, cwd: '/repo/game', readTty: noTty });
  assert.equal(a, b);
  assert.equal(isAmbiguousSessionId(a), true);
});

test('the fallback hash still separates different directories', () => {
  const a = sessionId({ env: {}, cwd: '/repo', readTty: noTty });
  const b = sessionId({ env: {}, cwd: '/repo/game', readTty: noTty });
  assert.notEqual(a, b);
});

const NOW = new Date('2026-07-28T12:00:00Z').getTime();
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();

test('an unowned plan can be claimed', () => {
  const d = claimDecision({ currentOwner: null, claimant: 'claude-a', now: NOW });
  assert.equal(d.allow, true);
  assert.equal(d.reason, 'unowned');
});

test('re-claiming our own plan is allowed and is not a conflict', () => {
  const d = claimDecision({
    currentOwner: 'claude-a', claimant: 'claude-a',
    ownerLastHeartbeat: minutesAgo(1), now: NOW,
  });
  assert.equal(d.allow, true);
  assert.equal(d.reason, 'self');
});

test('a plan owned by a LIVE other session is refused', () => {
  const d = claimDecision({
    currentOwner: 'claude-a', claimant: 'claude-b',
    ownerLastHeartbeat: minutesAgo(30), now: NOW, staleHours: 4,
  });
  assert.equal(d.allow, false);
  assert.equal(d.reason, 'owned-by-live-session');
  assert.equal(d.currentOwner, 'claude-a');
});

test('a plan owned by a STALE session may be claimed', () => {
  const d = claimDecision({
    currentOwner: 'claude-a', claimant: 'claude-b',
    ownerLastHeartbeat: minutesAgo(60 * 9), now: NOW, staleHours: 4,
  });
  assert.equal(d.allow, true);
  assert.equal(d.reason, 'owner-stale');
});

test('an owner with no heartbeat at all counts as stale', () => {
  const d = claimDecision({
    currentOwner: 'claude-a', claimant: 'claude-b',
    ownerLastHeartbeat: null, now: NOW,
  });
  assert.equal(d.allow, true);
  assert.equal(d.reason, 'owner-stale');
});

test('--force overrides a live owner, and says so', () => {
  const d = claimDecision({
    currentOwner: 'claude-a', claimant: 'claude-b',
    ownerLastHeartbeat: minutesAgo(5), now: NOW, force: true,
  });
  assert.equal(d.allow, true);
  assert.equal(d.reason, 'forced');
  assert.equal(d.currentOwner, 'claude-a', 'the force warning must be able to name who was displaced');
});

test('releasing a plan we own clears the owner', () => {
  const d = releaseDecision({ currentOwner: 'claude-a', claimant: 'claude-a' });
  assert.equal(d.clearOwner, true);
  assert.equal(d.reason, 'owner');
});

// The corruption case: a superseded session releasing late must NOT null out the
// ownership of the session that took over and is still working.
test('releasing a plan someone else now owns does not clear the owner', () => {
  const d = releaseDecision({ currentOwner: 'claude-b', claimant: 'claude-a' });
  assert.equal(d.clearOwner, false);
  assert.equal(d.reason, 'not-owner');
});

test('releasing an already-unowned plan is a no-op, not an error', () => {
  const d = releaseDecision({ currentOwner: null, claimant: 'claude-a' });
  assert.equal(d.clearOwner, false);
  assert.equal(d.reason, 'already-unowned');
});

// FINDING 1. A session that claims a second plan without releasing the first
// overwrites its own record — SKILL.md explicitly recommends that workflow — so
// the first plan keeps an owner nobody holds. Harmless before claim could refuse.
test('a plan whose owner has moved on to another plan can be claimed', () => {
  const d = claimDecision({
    currentOwner: 'claude-a', claimant: 'claude-b',
    ownerLastHeartbeat: minutesAgo(1), now: NOW,
    ownerPlanPath: 'plans/other.md', planPath: 'plans/mine.md',
  });
  assert.equal(d.allow, true);
  assert.equal(d.reason, 'owner-moved-on');
});

test('a live owner still holding THIS plan is still refused', () => {
  const d = claimDecision({
    currentOwner: 'claude-a', claimant: 'claude-b',
    ownerLastHeartbeat: minutesAgo(1), now: NOW,
    ownerPlanPath: 'plans/mine.md', planPath: 'plans/mine.md',
  });
  assert.equal(d.allow, false);
  assert.equal(d.reason, 'owned-by-live-session');
});

test('an owner with no session record at all is still treated as stale', () => {
  const d = claimDecision({
    currentOwner: 'claude-a', claimant: 'claude-b',
    ownerLastHeartbeat: null, now: NOW,
    ownerPlanPath: null, planPath: 'plans/mine.md',
  });
  assert.equal(d.allow, true);
  assert.equal(d.reason, 'owner-stale');
});

// FINDING 2. --force makes displacement supported, and the displaced session is
// never told. Its Stop hook would keep bumping last_touched on a plan it lost —
// the exact signal the neglect sweep is built on.
test('we may write to a plan we still own', () => {
  assert.equal(ownsPlan('claude-a', 'claude-a'), true);
});

test('we may NOT write to a plan taken from us', () => {
  assert.equal(ownsPlan('claude-b', 'claude-a'), false);
});

test('an unowned plan is not ours to write to either', () => {
  assert.equal(ownsPlan(null, 'claude-a'), false);
});

// FINDING 3. Deleting this branch left the suite green — a whole documented
// resolution branch was unguarded.
test('CLAUDE_SESSION_ID is honoured when it is the only session env', () => {
  assert.equal(
    sessionId({ env: { CLAUDE_SESSION_ID: 'abc123' }, cwd: '/repo', readTty: () => '' }),
    'claude-abc123',
  );
});

// FIX ROUND. resolveRel (index.mjs) feeds normalizePlanPath's output into
// claimDecision as an equality KEY (ownerPlanPath vs planPath), not just a
// label. Before this, 'plans/x.md' and './plans/x.md' named the same file but
// compared unequal — a session re-claiming through a differently-spelled path
// would make a live owner look "moved on" and get displaced with no --force.
test('normalizePlanPath collapses cosmetic path spellings to one key', () => {
  assert.equal(normalizePlanPath('./plans/mine.md'), normalizePlanPath('plans/mine.md'));
  assert.equal(normalizePlanPath('plans//mine.md'), normalizePlanPath('plans/mine.md'));
});

// FIX ROUND 2. normalizePlanPath alone only proved the function works in
// isolation — resolveRel normalizes what we WRITE, but ownerPlanPath is read
// straight off a session record on disk, which may predate this fix (or belong
// to a session that hasn't re-claimed since). Without normalizing inside
// claimDecision itself, a live owner's record spelled './plans/mine.md' still
// looked "moved on" from a claim for 'plans/mine.md' and got displaced with no
// --force — the original hole, just narrowed to only-until-next-claim instead
// of closed.
test('an owner record with a non-canonical plan path is still recognised as holding this plan', () => {
  const d = claimDecision({
    currentOwner: 'claude-a', claimant: 'claude-b',
    ownerLastHeartbeat: minutesAgo(1), now: NOW,
    ownerPlanPath: './plans/mine.md', planPath: 'plans/mine.md',
  });
  assert.equal(d.allow, false, 'a cosmetic path difference must not displace a live owner');
  assert.equal(d.reason, 'owned-by-live-session');
});

// ─── Fallback-id safety on lifecycle ops ──────────────────────────────────
// Warning about a fallback id (what `claim` used to do) was not enough: a
// lifecycle op under a shared id reads and writes whatever record that id
// names, and on 2026-07-30 a `release` through a colliding fallback dropped
// another terminal's claim. Refusal, with an explicit override, is the only
// safe default. MUTANT: return {allow:true} unconditionally → the first two red.

test('a lifecycle op under a fallback id is refused', () => {
  const g = lifecycleGuard({ sid: 'fallback-1a2b3c4d' });
  assert.equal(g.allow, false);
  assert.equal(g.reason, 'ambiguous-session');
  assert.match(g.message, /fallback/i, 'the refusal must name the cause');
  assert.match(g.message, /--force/, 'and how to override it');
});

test('--force takes a fallback id anyway, so a lone session is never stuck', () => {
  const g = lifecycleGuard({ sid: 'fallback-1a2b3c4d', force: true });
  assert.equal(g.allow, true);
  assert.equal(g.reason, 'forced-ambiguous');
  assert.match(g.message, /fallback/i, 'forcing still warns — the risk did not go away');
});

test('a stable session id passes the guard silently', () => {
  const g = lifecycleGuard({ sid: 'term-w0t1p0:ABC' });
  assert.equal(g.allow, true);
  assert.equal(g.reason, 'stable-id');
  assert.equal(g.message, null);
});
