// The Scribe engine against REAL frames.
//
// Every transcript frame these tests dispatch was captured verbatim from the
// live service (spike/ear, 2026-08-29) — fixtures/ holds the JSONL. That is
// the standing rule about fixtures: the invented node---test fixture passed
// green while real output tripled entries, and an invented Scribe payload
// would be worth exactly as much.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ScribeEngine } from './scribeEngine.ts';
import type { EarState } from './engine.ts';

/** Received frames from a spike capture, in order. */
function fixtureFrames(name: string): any[] {
  const raw = fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.dir === 'recv')
    .map((e) => e.frame);
}

class FakeSocket {
  static instances: FakeSocket[] = [];
  url: string;
  sent: any[] = [];
  readyState = 0;
  private listeners: Record<string, ((ev: any) => void)[]> = {};
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: any) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.emit('close', { code, reason: '' });
  }
  // --- test-side controls ---
  open() {
    this.readyState = 1;
    this.emit('open', {});
  }
  frame(obj: unknown) {
    this.emit('message', { data: JSON.stringify(obj) });
  }
  serverClose(code: number, reason = '') {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }
  emit(type: string, ev: any) {
    for (const f of this.listeners[type] ?? []) f(ev);
  }
}

const okMint = async () =>
  ({ ok: true, status: 200, text: async () => '{"token":"sutkn_test"}' }) as unknown as Response;

async function until(cond: () => boolean, ms = 1000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function harness(engineOpts: Partial<ConstructorParameters<typeof ScribeEngine>[0]> = {}, keyterms?: string[]) {
  FakeSocket.instances.length = 0;
  const partials: string[] = [];
  const commits: string[] = [];
  const states: { state: EarState; detail?: string }[] = [];
  let seconds = 0;
  const engine = new ScribeEngine({
    apiKey: 'k',
    fetchFn: okMint as unknown as typeof fetch,
    webSocketFactory: (u) => new FakeSocket(u) as unknown as WebSocket,
    ...engineOpts,
  });
  const session = engine.start({
    keyterms,
    onPartial: (t) => partials.push(t),
    onCommit: (t) => commits.push(t),
    onState: (state, detail) => states.push({ state, detail }),
    onAudioForwarded: (s) => (seconds += s),
  });
  return { session, partials, commits, states, spent: () => seconds };
}

test('the canonical run: real frames in, the fixture transcript out', async () => {
  const { session, partials, commits, states } = harness();
  await until(() => FakeSocket.instances.length === 1);
  const sock = FakeSocket.instances[0];
  sock.open();
  const frames = fixtureFrames('vad-keyterms-repeat.jsonl');
  for (const f of frames) sock.frame(f);
  assert.deepEqual(states[0], { state: 'live', detail: undefined }, 'session_started is the go signal');
  assert.equal(partials.length, 9, 'every partial delivered');
  assert.deepEqual(commits, ["Let's check the settle period. Does pnpm work with colyseus? Open beadgame, then run the tests."]);
  await session.close();
  assert.equal(states.at(-1)?.state, 'closed');
});

test('socket open is NOT the go signal — auth_error after open degrades', async () => {
  const { session, states, commits } = harness();
  await until(() => FakeSocket.instances.length === 1);
  const sock = FakeSocket.instances[0];
  sock.open();
  // Captured live: the socket opens cleanly, THEN the service says no.
  for (const f of fixtureFrames('auth-error.jsonl')) sock.frame(f);
  assert.equal(states[0].state, 'degraded');
  assert.match(states[0].detail ?? '', /auth_error: You must be authenticated/);
  sock.serverClose(1000);
  assert.deepEqual(commits, []);
  assert.equal(states.filter((s) => s.state === 'degraded').length, 1, 'the close does not double-report');
  await session.close();
});

test('a fatal handshake config degrades with the service reason', async () => {
  const { states } = harness();
  await until(() => FakeSocket.instances.length === 1);
  const sock = FakeSocket.instances[0];
  sock.open();
  // Captured live: the JSON-array keyterms mistake — invalid_request, then 1008.
  for (const f of fixtureFrames('vad-keyterms.jsonl')) sock.frame(f);
  sock.serverClose(1008, 'invalid_request');
  assert.equal(states[0].state, 'degraded');
  assert.match(states[0].detail ?? '', /invalid_request.*20 characters/);
});

test('a refused token mint degrades without ever opening a socket', async () => {
  FakeSocket.instances.length = 0;
  const states: { state: EarState; detail?: string }[] = [];
  const engine = new ScribeEngine({
    apiKey: 'k',
    fetchFn: (async () => ({ ok: false, status: 401, text: async () => '{"detail":"missing permission"}' })) as unknown as typeof fetch,
    webSocketFactory: (u) => new FakeSocket(u) as unknown as WebSocket,
  });
  const session = engine.start({ onPartial: () => {}, onCommit: () => {}, onState: (s, d) => states.push({ state: s, detail: d }) });
  await until(() => states.length > 0);
  assert.equal(states[0].state, 'degraded');
  assert.match(states[0].detail ?? '', /token mint refused \(HTTP 401\)/);
  assert.equal(FakeSocket.instances.length, 0);
  await session.close();
});

test('the handshake URL: token, vad, and keyterms as REPEATED params', async () => {
  const { session } = harness({ vadSilenceSecs: 2 }, ['pnpm', 'colyseus']);
  await until(() => FakeSocket.instances.length === 1);
  const url = new URL(FakeSocket.instances[0].url);
  assert.equal(url.searchParams.get('token'), 'sutkn_test');
  assert.equal(url.searchParams.get('model_id'), 'scribe_v2_realtime');
  assert.equal(url.searchParams.get('commit_strategy'), 'vad');
  assert.equal(url.searchParams.get('vad_silence_threshold_secs'), '2');
  assert.deepEqual(url.searchParams.getAll('keyterms'), ['pnpm', 'colyseus']);
  await session.close();
});

test('an oversized keyterm is dropped LOUDLY, not sent, not silent', async () => {
  const long = 'a'.repeat(21);
  const { session, states } = harness({}, ['pnpm', long]);
  await until(() => FakeSocket.instances.length === 1);
  const url = new URL(FakeSocket.instances[0].url);
  assert.deepEqual(url.searchParams.getAll('keyterms'), ['pnpm'], 'the fatal term never reaches the wire');
  assert.ok(
    states.some((s) => s.detail?.includes(long)),
    'what fell off is reported by name'
  );
  await session.close();
});

test('audio pushed early queues, flushes on open, and is metered at forwarding', async () => {
  const { session, spent } = harness();
  const chunk = Int16Array.from({ length: 8000 }, (_, i) => i % 32);
  session.push(chunk); // half a second, before the socket exists
  await until(() => FakeSocket.instances.length === 1);
  const sock = FakeSocket.instances[0];
  assert.equal(sock.sent.length, 0);
  assert.equal(spent(), 0, 'queued audio is not spend — nothing was forwarded');
  sock.open();
  assert.equal(sock.sent.length, 1);
  const sent = sock.sent[0];
  assert.equal(sent.message_type, 'input_audio_chunk');
  assert.equal(sent.sample_rate, 16000);
  assert.equal(sent.commit, false);
  const bytes = Buffer.from(sent.audio_base_64, 'base64');
  assert.deepEqual(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2), chunk, 'the audio round-trips');
  assert.equal(spent(), 0.5);
  session.push(chunk);
  assert.equal(spent(), 1);
  await session.close();
});

test('abandon swallows the utterance in flight and ONLY that utterance', async () => {
  const { session, partials, commits } = harness();
  await until(() => FakeSocket.instances.length === 1);
  const sock = FakeSocket.instances[0];
  sock.open();
  sock.frame({ message_type: 'session_started', session_id: 's' });
  sock.frame({ message_type: 'partial_transcript', text: 'delete every' });
  assert.deepEqual(partials, ['delete every']);
  session.abandon();
  // The service goes on talking about audio already sent; none of it surfaces.
  sock.frame({ message_type: 'partial_transcript', text: 'delete everything now' });
  sock.frame({ message_type: 'committed_transcript', text: 'Delete everything now.' });
  assert.deepEqual(partials, ['delete every']);
  assert.deepEqual(commits, []);
  // The swallowed commit closed the abandoned utterance; the next one is his.
  sock.frame({ message_type: 'partial_transcript', text: 'never mind' });
  sock.frame({ message_type: 'committed_transcript', text: 'Never mind.' });
  assert.deepEqual(commits, ['Never mind.']);
  await session.close();
});

test('abandon with nothing in flight is a no-op, not a debt', async () => {
  const { session, commits } = harness();
  await until(() => FakeSocket.instances.length === 1);
  const sock = FakeSocket.instances[0];
  sock.open();
  sock.frame({ message_type: 'session_started', session_id: 's' });
  session.abandon(); // nothing heard yet
  sock.frame({ message_type: 'partial_transcript', text: 'hello' });
  sock.frame({ message_type: 'committed_transcript', text: 'Hello.' });
  assert.deepEqual(commits, ['Hello.'], 'the next sentence must not be eaten');
  await session.close();
});

test('an unasked-for close degrades; a requested one just closes', async () => {
  const a = harness();
  await until(() => FakeSocket.instances.length === 1);
  const sockA = FakeSocket.instances[0];
  sockA.open();
  sockA.frame({ message_type: 'session_started', session_id: 's' });
  sockA.serverClose(1011, 'server going away');
  assert.equal(a.states.find((s) => s.state === 'degraded')?.detail, 'connection closed (1011 server going away)');
  await a.session.close();

  // harness() resets the instance list, so the fresh socket is index 0 again.
  const b = harness();
  await until(() => FakeSocket.instances.length === 1);
  const sockB = FakeSocket.instances[0];
  sockB.open();
  sockB.frame({ message_type: 'session_started', session_id: 's' });
  await b.session.close();
  assert.ok(!b.states.some((s) => s.state === 'degraded'), 'closing on purpose is not a failure');
  assert.equal(b.states.at(-1)?.state, 'closed');
});
