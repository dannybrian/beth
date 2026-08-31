// The speech plane's ADAPTER — the bus-facing half of what these tests used to
// cover before the core moved to src/mouth/ (whose tests took the rest). What
// is under test here is the conversation wiring: the one subscription that IS
// the plane, the speech level and its excerpting, and what does (and does not)
// ride the bus.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationBus, type UIMessage } from './bus.ts';
import { SpeakOut } from './speakOut.ts';
import { VoiceRoom } from './voiceRoom.ts';
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

// --- the machine's voice room -------------------------------------------------
//
// Everything below runs two adapters against one real directory, standing in
// for two harnesses on one Mac. Failures here are the invisible kind: a stick
// never released looks like every OTHER beth going quiet, and a mute that
// merely delayed lines would bill for audio nobody asked to hear.

const roomDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-speakroom-'));
const stickAt = (dir: string) => fs.existsSync(path.join(dir, 'voice.stick'));

async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition never held');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('the stick is taken at publish and released when the page reports done', () => {
  const dir = roomDir();
  const room = new VoiceRoom(dir);
  const { bus, seen } = recording();
  const s = new SpeakOut(cfg(), bus, room, { lingerMs: () => 0 });
  const id = s.speak('Tests are green.');
  assert.equal(spoken(seen).length, 1, 'an uncontended stick must not delay the line');
  assert.equal(stickAt(dir), true);
  s.playbackDone([id!]);
  assert.equal(stickAt(dir), false, 'a played-out thought must free the machine');
  room.close();
});

test('a second beth waits for the stick, then says her line — in order', async () => {
  const dir = roomDir();
  const roomA = new VoiceRoom(dir);
  const roomB = new VoiceRoom(dir);
  const a = recording();
  const b = recording();
  const bethA = new SpeakOut(cfg(), a.bus, roomA, { lingerMs: () => 0 });
  const bethB = new SpeakOut(cfg(), b.bus, roomB, { lingerMs: () => 0 });
  const idA = bethA.speak('A long thought from the first beth.');
  bethB.speak('The second beth, waiting her turn.');
  bethB.speak('And her second line.');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(spoken(b.seen).length, 0, 'two voices at once is the bug this exists to fix');
  bethA.playbackDone([idA!]);
  await until(() => spoken(b.seen).length === 2);
  // Held for the whole thought: both queued lines ride one acquisition, in the
  // order she said them.
  assert.deepEqual(spoken(b.seen).map((m) => bethB.textFor(m.id)), [
    'The second beth, waiting her turn.',
    'And her second line.',
  ]);
  bethB.playbackDone(spoken(b.seen).map((m) => m.id));
  assert.equal(stickAt(dir), false);
  roomA.close();
  roomB.close();
});

test('the universal mute drops ambient speech before it is even held', () => {
  const dir = roomDir();
  const room = new VoiceRoom(dir);
  room.setMuted(true);
  const { bus, seen } = recording();
  const s = new SpeakOut(cfg(), bus, room);
  bus.publish({ type: 'assistant', text: 'Nobody hears this.' });
  assert.equal(spoken(seen).length, 0);
  // Not held either: never announced, never fetched, never billed — and
  // nothing replays on unmute, because that news has passed.
  assert.equal(s.status().held, 0);
  room.setMuted(false);
  assert.equal(spoken(seen).length, 0, 'unmute must not unleash a backlog');
  room.close();
});

test('direct speak() — the reread click — goes through the mute', () => {
  // A click is an explicit request, the same rule that lets reread speak at
  // level "off". The stick still applies: explicit is not a license to overlap.
  const dir = roomDir();
  const room = new VoiceRoom(dir);
  room.setMuted(true);
  const { bus, seen } = recording();
  const s = new SpeakOut(cfg(), bus, room);
  const id = s.speak('Read this back to me.');
  assert.ok(id);
  assert.equal(spoken(seen).length, 1);
  s.playbackDone([id!]);
  room.close();
});

test('no page connected: publish immediately and leave the stick alone', () => {
  // Nothing will play the line, so holding the stick would let a boot with no
  // tab yet silence every other beth for the length of the backstop.
  const dir = roomDir();
  const room = new VoiceRoom(dir);
  const { bus, seen } = recording();
  const s = new SpeakOut(cfg(), bus, room);
  s.setAudience(() => false);
  s.speak('Spoken into an empty room.');
  assert.equal(spoken(seen).length, 1);
  assert.equal(stickAt(dir), false);
  room.close();
});

test('the backstop frees a stick whose page never reported back', async () => {
  const dir = roomDir();
  const room = new VoiceRoom(dir);
  const { bus } = recording();
  const s = new SpeakOut(cfg(), bus, room, { backstopMs: () => 50, lingerMs: () => 0 });
  s.speak('A tab took this line and closed.');
  assert.equal(stickAt(dir), true);
  await until(() => !stickAt(dir));
  room.close();
});

test('the stick lingers through the writing gaps of a list', async () => {
  // Line played, next line still being generated: releasing at the instant of
  // drain is how another beth sneaked in mid-list. The linger carries the hold
  // across the gap, and the next line rides it without re-contending.
  const dir = roomDir();
  const room = new VoiceRoom(dir);
  const { bus, seen } = recording();
  const s = new SpeakOut(cfg(), bus, room, { lingerMs: () => 150 });
  const first = s.speak('Item one.');
  s.playbackDone([first!]);
  assert.equal(stickAt(dir), true, 'drained is not done — the thought has a linger');
  s.speak('Item two.');
  assert.equal(spoken(seen).length, 2, 'a line inside the linger rides the same hold');
  s.playbackDone([spoken(seen)[1].id]);
  await until(() => !stickAt(dir));
  room.close();
});

test('her turn ending cuts a long linger down, and the stick frees', async () => {
  const dir = roomDir();
  const room = new VoiceRoom(dir);
  const { bus } = recording();
  const s = new SpeakOut(cfg(), bus, room, { lingerMs: (busy) => (busy ? 60_000 : 20) });
  bus.publish({ type: 'status', state: 'thinking' });
  const id = s.speak('Mid-turn note.');
  s.playbackDone([id!]);
  assert.equal(stickAt(dir), true, 'mid-turn, more lines are plausibly coming');
  bus.publish({ type: 'status', state: 'idle' });
  await until(() => !stickAt(dir));
  room.close();
});

test('backstops size to the unplayed queue, and a page report restarts them', async () => {
  // A tail line sized only to itself expired while still waiting its turn on
  // the page — early release over live audio. So: sized cumulatively at
  // publish, restarted when the page proves it is alive, and NOT restarted by
  // a backstop firing (a dead tab's timers must burn down once each, not feed
  // each other).
  const dir = roomDir();
  const room = new VoiceRoom(dir);
  const { bus, seen } = recording();
  const sized: number[] = [];
  const s = new SpeakOut(cfg(), bus, room, {
    lingerMs: () => 0,
    backstopMs: (chars) => (sized.push(chars), 200 + chars * 10),
  });
  s.speak('aaaaa'); // 5 chars
  s.speak('bbbbbb'); // 6
  s.speak('ccccccc'); // 7
  assert.deepEqual(sized, [5, 11, 18], 'each line waits behind everything ahead of it');
  s.playbackDone([spoken(seen)[0].id]); // the page is alive, just not up to them yet
  assert.deepEqual(sized, [5, 11, 18, 6, 13], 'the survivors restart, re-sized to what remains');
  // The remaining two now die by backstop alone — no further sizing calls.
  await until(() => !stickAt(dir));
  assert.deepEqual(sized, [5, 11, 18, 6, 13]);
  room.close();
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
