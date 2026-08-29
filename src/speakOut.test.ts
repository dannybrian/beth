// The speech plane's ADAPTER — the bus-facing half of what these tests used to
// cover before the core moved to src/mouth/ (whose tests took the rest). What
// is under test here is the conversation wiring: the one subscription that IS
// the plane, the speech level and its excerpting, and what does (and does not)
// ride the bus.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationBus, type UIMessage } from './bus.ts';
import { SpeakOut } from './speakOut.ts';
import type { HarnessConfig } from './config.ts';

const cfg = (over: Partial<HarnessConfig> = {}): HarnessConfig =>
  ({
    elevenLabsApiKey: 'sk_test',
    voiceId: 'v_test',
    ttsModel: 'eleven_flash_v2_5',
    speechLevel: 'full',
    ttsUsdPer1kCredits: 0.22,
    ...over,
  }) as HarnessConfig;

/** A bus that records what was published, in order. */
function recording() {
  const bus = new ConversationBus();
  const seen: UIMessage[] = [];
  bus.subscribe((m) => seen.push(m));
  return { bus, seen };
}

const spoken = (seen: UIMessage[]) => seen.filter((m) => m.type === 'speak') as (UIMessage & { type: 'speak' })[];

test('a spoken line is published as an id, and the words stay off the wire', () => {
  const { bus, seen } = recording();
  const s = new SpeakOut(cfg(), bus);
  const id = s.speak('Tests are green.');
  assert.ok(id);
  assert.deepEqual(seen, [{ type: 'speak', id, chars: 'Tests are green.'.length }]);
  // The transcript already carries the words; shipping them twice invites a copy.
  assert.equal('text' in seen[0], false);
  assert.equal(s.textFor(id!), 'Tests are green.');
});

test('speaking does NOT wait for anything — no session, no mic, no transcript', () => {
  // The whole point of the plane. There is no state to set up first.
  const { bus, seen } = recording();
  const id = new SpeakOut(cfg(), bus).speak('Shipped.');
  assert.ok(id);
  assert.equal(seen.length, 1);
});

test('a `speak` message is never replayed — a reconnect must not re-perform', () => {
  // Replaying it would make a page that refreshed say the whole conversation
  // out loud again.
  const bus = new ConversationBus();
  new SpeakOut(cfg(), bus).speak('Tests are green.');
  assert.deepEqual(bus.replay().map((m) => m.type), []);
});

test('unconfigured stays silent through the adapter, and says why', () => {
  const { bus, seen } = recording();
  const s = new SpeakOut(cfg({ elevenLabsApiKey: undefined }), bus);
  assert.equal(s.speak('anything'), null);
  assert.ok(s.unavailableReason);
  assert.equal(s.configured, false);
  assert.equal(seen.length, 0);
});

// --- the whole speech plane is one subscription ------------------------------

test('what she WRITES is what she says — no turn to correlate with', () => {
  const { bus, seen } = recording();
  new SpeakOut(cfg(), bus);
  bus.publish({ type: 'assistant', text: 'Tests are green.' });
  bus.publish({ type: 'say', kind: 'status', text: 'Shipped.' });
  assert.deepEqual(
    spoken(seen).map((m) => m.chars),
    ['Tests are green.'.length, 'Shipped.'.length]
  );
});

test('her own transcript does not echo — only assistant and say are spoken', () => {
  const { bus, seen } = recording();
  new SpeakOut(cfg(), bus);
  bus.publish({ type: 'user', text: 'run the tests' });
  bus.publish({ type: 'activity', tool: 'Bash', detail: 'pnpm test' });
  assert.equal(spoken(seen).length, 0);
});

test('the speech LEVEL decides what is pronounced, and only that', () => {
  const { bus, seen } = recording();
  const s = new SpeakOut(cfg({ speechLevel: 'brief' }), bus);
  // 'brief' speaks the last paragraph — the upshot, not the essay in front of it.
  bus.publish({ type: 'assistant', text: 'A long preamble about the change.\n\nSo the tree is green.' });
  assert.equal(s.textFor(spoken(seen)[0].id), 'So the tree is green.');
});

test('silence is a real setting — `off` speaks nothing and queues nothing', () => {
  // Nothing waits for later either: that silence is a choice, not a line held
  // back for a channel that is never coming.
  const { bus, seen } = recording();
  const s = new SpeakOut(cfg({ speechLevel: 'off' }), bus);
  bus.publish({ type: 'assistant', text: 'Tests are green.' });
  assert.equal(spoken(seen).length, 0);
  assert.equal(s.status().held, 0);
});

test('the level switches live, and says so on the bus', () => {
  const { bus, seen } = recording();
  const s = new SpeakOut(cfg({ speechLevel: 'off' }), bus);
  s.setSpeechLevel('full');
  assert.equal(s.speechLevel(), 'full');
  assert.ok(seen.some((m) => m.type === 'speech' && m.level === 'full'));
  bus.publish({ type: 'assistant', text: 'Now audible.' });
  assert.equal(spoken(seen).length, 1);
});

test('setVoice and speechLevel survive being passed by REFERENCE', () => {
  // main.ts hands these methods around detached (`setVoice: speakOut.setVoice`)
  // — a refactor that turned them into plain methods would lose `this` and fail
  // only at persona-switch time, in production, silently.
  const { bus } = recording();
  const s = new SpeakOut(cfg(), bus);
  const { setVoice, speechLevel, currentVoice } = s;
  setVoice('v_other');
  assert.equal(currentVoice(), 'v_other');
  assert.equal(speechLevel(), 'full');
});
