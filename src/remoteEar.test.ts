// RemoteEar wearing the Listener's face — the page half of the Scribe ear.
//
// What is under test is the CONTRACT the composer already depends on, ported
// across the seam: off() never sends, commits drop while she is talking or
// while parked, a steal turns the mic off in the tab that lost it, and
// degraded hands the mic to whatever "listen another way" means. All
// behaviours whose failure is a composer doing something Danny didn't say.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteEar } from '../ui/remoteEar.js';

class FakeCapture {
  armed = false;
  parked = false;
  async arm() {
    this.armed = true;
  }
  async off() {
    this.armed = false;
    this.parked = false;
  }
  park() {
    if (this.armed) this.parked = true;
  }
  unpark() {
    this.parked = false;
  }
}

function build(overrides: Record<string, unknown> = {}) {
  const posts: { path: string; body: any }[] = [];
  const events: { kind: string; args: unknown[] }[] = [];
  let speaking = false;
  const capture = new FakeCapture();
  const ear = new RemoteEar({
    streamId: () => 7,
    capture,
    post: async (path: string, body: unknown) => {
      posts.push({ path, body });
      return { ok: true };
    },
    onState: (...a: unknown[]) => events.push({ kind: 'state', args: a }),
    onInterim: (...a: unknown[]) => events.push({ kind: 'interim', args: a }),
    onSettled: (...a: unknown[]) => events.push({ kind: 'settled', args: a }),
    onDegraded: (...a: unknown[]) => events.push({ kind: 'degraded', args: a }),
    isSpeaking: () => speaking,
    stopSpeaking: () => {},
    ...overrides,
  });
  return { ear, posts, events, capture, setSpeaking: (v: boolean) => (speaking = v) };
}

test('arm: mic first, then the server, then listening', async () => {
  const { ear, posts, events, capture } = build();
  await ear.arm();
  assert.equal(capture.armed, true);
  assert.deepEqual(posts, [{ path: '/api/ear', body: { on: true, streamId: 7 } }]);
  assert.deepEqual(events, [{ kind: 'state', args: ['listening'] }]);
  assert.equal(ear.state, 'listening');
});

test('a refused arm releases the mic and says why', async () => {
  const { ear, events, capture } = build({
    post: async () => ({ ok: false, reason: 'no ELEVENLABS_API_KEY' }),
  });
  await ear.arm();
  assert.equal(capture.armed, false, 'no half-armed mic behind an error state');
  assert.equal(ear.state, 'error');
  assert.deepEqual(events.at(-1), { kind: 'state', args: ['error', 'no ELEVENLABS_API_KEY'] });
});

test('partials and commits reach the composer callbacks', async () => {
  const { ear, events } = build();
  await ear.arm();
  ear.onEar({ state: 'partial', text: 'hel', owner: 7 });
  ear.onEar({ state: 'commit', text: 'Hello there.', owner: 7 });
  assert.deepEqual(events.slice(1), [
    { kind: 'interim', args: ['hel'] },
    { kind: 'settled', args: ['Hello there.'] },
  ]);
});

test("another tab's frames are not this composer's", async () => {
  const { ear, events } = build();
  await ear.arm();
  ear.onEar({ state: 'partial', text: 'other', owner: 8 });
  ear.onEar({ state: 'commit', text: 'Other.', owner: 8 });
  assert.equal(events.length, 1, 'only the arm state event');
});

test('⚠️ off() never sends what it was holding', async () => {
  const { ear, posts, events } = build();
  await ear.arm();
  ear.onEar({ state: 'partial', text: 'delete every', owner: 7 });
  await ear.off();
  // A late commit for audio already sent must not fire a turn out of a closed ear.
  ear.onEar({ state: 'commit', text: 'Delete everything.', owner: 7 });
  assert.ok(!events.some((e) => e.kind === 'settled'), 'closing the ear is a way OUT of the sentence');
  assert.deepEqual(posts.at(-1), { path: '/api/ear', body: { on: false, streamId: 7 } });
});

test('abandon reaches the SERVER — the words live in the Scribe session', async () => {
  const { ear, posts } = build();
  await ear.arm();
  ear.abandon();
  assert.deepEqual(posts.at(-1), { path: '/api/ear/abandon', body: { streamId: 7 } });
});

test('parked or her-speaking frames are dropped, and unpark resumes', async () => {
  const { ear, events, setSpeaking } = build();
  await ear.arm();
  ear.park();
  ear.onEar({ state: 'commit', text: 'Her own words.', owner: 7 });
  ear.unpark();
  setSpeaking(true);
  ear.onEar({ state: 'commit', text: 'Still hers.', owner: 7 });
  setSpeaking(false);
  ear.onEar({ state: 'commit', text: 'His again.', owner: 7 });
  assert.deepEqual(
    events.filter((e) => e.kind === 'settled').map((e) => e.args[0]),
    ['His again.']
  );
});

test('a steal turns this mic off, with the reason, without a server post', async () => {
  const { ear, posts, events, capture } = build();
  await ear.arm();
  const postsBefore = posts.length;
  ear.onEar({ state: 'off', owner: 7, detail: 'the mic moved to another tab' });
  assert.equal(ear.state, 'off');
  assert.equal(capture.armed, false);
  assert.equal(posts.length, postsBefore, 'the session is already gone; nothing to disarm');
  assert.deepEqual(events.at(-1), { kind: 'state', args: ['off', 'the mic moved to another tab'] });
});

test('degraded stops the capture and hands the decision up', async () => {
  const { ear, events, capture } = build();
  await ear.arm();
  ear.onEar({ state: 'degraded', owner: 7, detail: 'quota_exceeded: out' });
  assert.equal(ear.state, 'error');
  assert.equal(capture.armed, false);
  assert.deepEqual(events.at(-1), { kind: 'degraded', args: ['quota_exceeded: out'] });
});
