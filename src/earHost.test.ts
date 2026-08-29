// The one-ear rule, and the bill — the bookkeeping where a mistake shows up as
// a mic that seems armed in two tabs, or a spend meter that counts parked
// silence. The engine is faked; what is under test is ownership and routing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EarHost } from './earHost.ts';
import type { EarEngine, EarSession, EarSessionOpts } from './ear/engine.ts';

class FakeSession implements EarSession {
  pushed: Int16Array[] = [];
  abandoned = 0;
  closed = false;
  opts: EarSessionOpts;
  constructor(opts: EarSessionOpts) {
    this.opts = opts;
  }
  push(pcm: Int16Array) {
    this.pushed.push(pcm);
    this.opts.onAudioForwarded?.(pcm.length / 16000);
  }
  abandon() {
    this.abandoned++;
  }
  async close() {
    this.closed = true;
  }
}

function fakeEngine() {
  const sessions: FakeSession[] = [];
  const engine: EarEngine = {
    start: (opts) => {
      const s = new FakeSession(opts);
      sessions.push(s);
      return s;
    },
  };
  return { engine, sessions };
}

function host(engine: EarEngine | null, vocab: string[] = ['pnpm']) {
  const published: any[] = [];
  const h = new EarHost({
    engine,
    unavailable: 'no key',
    vocabulary: () => vocab,
    publish: (m) => published.push(m),
    usdPerHour: 0.39,
  });
  return { h, published };
}

test('no engine refuses with the reason, not a dead button', () => {
  const { h } = host(null);
  assert.deepEqual(h.arm(1), { ok: false, reason: 'no key' });
});

test('arming takes the vocabulary of the moment and routes frames to the owner', () => {
  const { engine, sessions } = fakeEngine();
  const { h, published } = host(engine);
  assert.deepEqual(h.arm(7), { ok: true });
  assert.deepEqual(sessions[0].opts.keyterms, ['pnpm']);
  sessions[0].opts.onPartial('hel');
  sessions[0].opts.onCommit('Hello.');
  assert.deepEqual(published, [
    { type: 'ear', state: 'partial', text: 'hel', owner: 7 },
    { type: 'ear', state: 'commit', text: 'Hello.', owner: 7 },
  ]);
});

test('ONE ear: a second tab arming closes the first session and tells it', () => {
  const { engine, sessions } = fakeEngine();
  const { h, published } = host(engine);
  h.arm(1);
  h.arm(2);
  assert.equal(sessions[0].closed, true, 'two armed tabs would be two paid sessions');
  assert.deepEqual(published[0], { type: 'ear', state: 'off', owner: 1, detail: 'the mic moved to another tab' });
  // The dead session's late frames go nowhere — not to the new owner.
  sessions[0].opts.onCommit('stale');
  assert.ok(!published.some((m) => m.text === 'stale'));
  sessions[1].opts.onCommit('fresh');
  assert.deepEqual(published.at(-1), { type: 'ear', state: 'commit', text: 'fresh', owner: 2 });
  // Re-arming by the current owner is idempotent, not a restart.
  h.arm(2);
  assert.equal(sessions.length, 2);
});

test('audio and abandon are owner-only; stragglers drop silently', () => {
  const { engine, sessions } = fakeEngine();
  const { h } = host(engine);
  h.arm(1);
  h.audio(2, Int16Array.from([1]));
  h.abandon(2);
  assert.equal(sessions[0].pushed.length, 0);
  assert.equal(sessions[0].abandoned, 0);
  h.audio(1, Int16Array.from([1, 2]));
  h.abandon(1);
  assert.equal(sessions[0].pushed.length, 1);
  assert.equal(sessions[0].abandoned, 1);
});

test('disarm is owner-only and ends the session', () => {
  const { engine, sessions } = fakeEngine();
  const { h } = host(engine);
  h.arm(1);
  h.disarm(2);
  assert.equal(sessions[0].closed, false);
  h.disarm(1);
  assert.equal(sessions[0].closed, true);
  assert.equal(h.owner(), 0);
});

test('a degraded session is dropped so the next arm starts fresh', () => {
  const { engine, sessions } = fakeEngine();
  const { h, published } = host(engine);
  h.arm(1);
  sessions[0].opts.onState('degraded', 'quota_exceeded: out');
  assert.deepEqual(published.at(-1), { type: 'ear', state: 'degraded', owner: 1, detail: 'quota_exceeded: out' });
  assert.equal(h.owner(), 0);
  h.arm(1);
  assert.equal(sessions.length, 2, 'the retry gets a new session, not the spent one');
});

test('the bill counts forwarded seconds and says its assumed rate', () => {
  const { engine } = fakeEngine();
  const { h } = host(engine);
  h.arm(1);
  h.audio(1, new Int16Array(16000)); // one second
  h.audio(1, new Int16Array(8000)); // half
  const spend = h.spend();
  assert.equal(spend.seconds, 2, 'rounded');
  assert.ok(Math.abs(spend.usd - (1.5 / 3600) * 0.39) < 1e-9);
  assert.equal(spend.usdPerHour, 0.39, 'the estimate names its assumption');
});
