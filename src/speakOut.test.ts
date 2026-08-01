import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationBus, type UIMessage } from './bus.ts';
import { SpeakOut } from './speakOut.ts';
import type { HarnessConfig } from './config.ts';

const cfg = (over: Partial<HarnessConfig> = {}): HarnessConfig =>
  ({
    speakOut: true,
    elevenLabsApiKey: 'sk_test',
    voiceId: 'v_test',
    ttsModel: 'eleven_flash_v2_5',
    audioTagsSupported: true,
    ...over,
  }) as HarnessConfig;

/** A bus that records what was published, in order. */
function recording() {
  const bus = new ConversationBus();
  const seen: UIMessage[] = [];
  bus.subscribe((m) => seen.push(m));
  return { bus, seen };
}

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
  for (const c of [cfg({ speakOut: false }), cfg({ elevenLabsApiKey: undefined }), cfg({ voiceId: undefined, speechEngineId: undefined })]) {
    assert.equal(new SpeakOut(c, bus).speak('anything'), null);
  }
  assert.equal(seen.length, 0);
});

test('an engine id alone is enough — the voice is inherited from it', () => {
  const { bus } = recording();
  const s = new SpeakOut(cfg({ voiceId: undefined, speechEngineId: 'seng_x' }), bus);
  assert.ok(s.speak('Ready.'));
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
  bus.publish({ type: 'assistant', text: 'and here is why' });
  assert.deepEqual(
    bus.replay().map((m) => m.type),
    ['assistant']
  );
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
