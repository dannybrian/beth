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

test('audio tags are stripped, because a realtime model reads them aloud', () => {
  const { bus } = recording();
  const s = new SpeakOut(cfg(), bus);
  const id = s.speak('[laughs] Tests are green.');
  assert.equal(s.textFor(id!), 'Tests are green.');
});

test('a line that is nothing BUT a tag never becomes a spoken line', () => {
  // It would otherwise mint an id the page fetches, pay for a request, and play
  // silence — and the caller would believe it had been said.
  const { bus, seen } = recording();
  const s = new SpeakOut(cfg(), bus);
  assert.equal(s.speak('[sighs]'), null);
  assert.equal(s.speak('   '), null);
  assert.equal(seen.length, 0);
});

test('tags SURVIVE when the model is a v3 one', () => {
  const { bus } = recording();
  const s = new SpeakOut(cfg({ ttsModel: 'eleven_v3' }), bus);
  const id = s.speak('[laughs] Tests are green.');
  assert.equal(s.textFor(id!), '[laughs] Tests are green.');
});

test('unconfigured is silent rather than throwing — voice is optional', () => {
  const { bus, seen } = recording();
  for (const c of [cfg({ elevenLabsApiKey: undefined }), cfg({ voiceId: undefined, speechEngineId: undefined })]) {
    const s = new SpeakOut(c, bus);
    assert.equal(s.speak('anything'), null);
    // And it says WHY, because a text-only harness that looks healthy is the
    // failure mode this whole plane exists to remove.
    assert.ok(s.unavailableReason);
  }
  assert.equal(seen.length, 0);
});

test('an engine id alone is enough — the voice is inherited from it', () => {
  const { bus } = recording();
  const s = new SpeakOut(cfg({ voiceId: undefined, speechEngineId: 'seng_x' }), bus);
  assert.ok(s.speak('Ready.'));
  assert.equal(s.unavailableReason, null);
});

test('held lines are capped, so an unattended run cannot grow forever', () => {
  const { bus } = recording();
  const s = new SpeakOut(cfg(), bus);
  for (let i = 0; i < 200; i++) s.speak(`line ${i}`);
  assert.ok(s.status().held <= 64, `held ${s.status().held}`);
  // The NEWEST survive: old news is the news worth dropping.
  assert.equal(s.textFor('s200'), 'line 199');
});

test('a `speak` message is never replayed — a reconnect must not re-perform', () => {
  // Replaying it would make a page that refreshed say the whole conversation
  // out loud again.
  const bus = new ConversationBus();
  new SpeakOut(cfg(), bus).speak('Tests are green.');
  assert.deepEqual(bus.replay().map((m) => m.type), []);
});

test('ids are unique across lines, so two never collide on one fetch', () => {
  const { bus } = recording();
  const s = new SpeakOut(cfg(), bus);
  const ids = new Set([s.speak('one'), s.speak('two'), s.speak('three')]);
  assert.equal(ids.size, 3);
});

test('an id is not consumed by reading it — a reload can ask again', () => {
  const { bus } = recording();
  const s = new SpeakOut(cfg(), bus);
  const id = s.speak('Tests are green.')!;
  assert.equal(s.textFor(id), 'Tests are green.');
  assert.equal(s.textFor(id), 'Tests are green.');
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

test('her own transcript does not echo — only assistant and say are spoken', () => {
  const { bus, seen } = recording();
  new SpeakOut(cfg(), bus);
  bus.publish({ type: 'user', text: 'run the tests' });
  bus.publish({ type: 'activity', tool: 'Bash', detail: 'pnpm test' });
  assert.equal(spoken(seen).length, 0);
});
