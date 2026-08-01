import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationBus } from './bus.ts';
import { VoiceService } from './voice.ts';
import type { HarnessConfig } from './config.ts';

/**
 * These cover the transcript-settling behaviour, which is where the real bug
 * lived: ElevenLabs delivers a growing utterance as several transcripts while
 * Danny is still talking, and acting on each one started a separate director
 * turn. One sentence became five, all running at once.
 */

const cfg = (over: Partial<HarnessConfig> = {}) =>
  ({
    voiceSettleMs: 40,
    fillerDelayMs: 10_000,
    audioTagsSupported: false,
    voiceEffort: null,
    ...over,
  }) as HarnessConfig;

/** Records the turns pushed into the director session. */
function fakeSession() {
  const sent: string[] = [];
  let seq = 0;
  return {
    sent,
    voiceActive: () => false,
    sendPointed: (t: string) => {
      sent.push(t);
      return ++seq;
    },
    send: (t: string) => {
      sent.push(t);
      return ++seq;
    },
    setEffort: async () => {},
  };
}

/** Stands in for the Speech Engine session; never iterates the response. */
const fakeSpeech = () => ({ sendResponse: async () => {} });

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

const schedule = (v: VoiceService, text: string, speech: unknown) =>
  (v as unknown as { scheduleTurn(t: string, s: unknown): void }).scheduleTurn(text, speech);

test('a growing utterance produces ONE turn, on the final text', async () => {
  const session = fakeSession();
  const v = new VoiceService(cfg(), new ConversationBus(), session as never);
  const speech = fakeSpeech();

  // Exactly the sequence from the log that started this.
  schedule(v, "I'm pretty sure we finished all the work on this plan.", speech);
  await settle(10);
  schedule(v, "I'm pretty sure we finished all the work on this plan, but let's review and see.", speech);
  await settle(10);
  schedule(v, "I'm pretty sure we finished all the work on this plan, but let's review and see, uh, if there was anything missed.", speech);
  await settle();

  assert.equal(session.sent.length, 1, 'one utterance must not become several director turns');
  assert.match(session.sent[0], /if there was anything missed\.$/, 'answers the newest revision');
});

test('a revision arriving inside the settle window resets the wait', async () => {
  const session = fakeSession();
  const v = new VoiceService(cfg({ voiceSettleMs: 60 }), new ConversationBus(), session as never);
  const speech = fakeSpeech();

  schedule(v, 'one', speech);
  await settle(40); // still inside the window
  assert.equal(session.sent.length, 0, 'must not fire while he is still talking');
  schedule(v, 'one two', speech);
  await settle(40);
  assert.equal(session.sent.length, 0, 'the second revision restarted the wait');
  await settle(60);
  assert.deepEqual(session.sent, ['one two']);
});

test('a continuation sends only the NEW words, not the question again', async () => {
  // What Danny hit: the window closed while he was mid-sentence, so the turn
  // fired early and the rest of the sentence arrived as a second transcript.
  // Transcripts accumulate, so re-sending the whole thing asks the same question
  // twice — and gets it answered twice.
  const session = fakeSession();
  const v = new VoiceService(cfg(), new ConversationBus(), session as never);
  const speech = fakeSpeech();

  schedule(v, 'did we finish the auth plan', speech);
  await settle();
  schedule(v, 'did we finish the auth plan, or is the device smoke still open', speech);
  await settle();

  assert.equal(session.sent.length, 2);
  assert.equal(session.sent[0], 'did we finish the auth plan');
  assert.equal(session.sent[1], ', or is the device smoke still open', 'only the added words');
});

test('a continuation of a continuation still only sends the newest words', async () => {
  const session = fakeSession();
  const v = new VoiceService(cfg(), new ConversationBus(), session as never);
  const speech = fakeSpeech();

  schedule(v, 'one', speech);
  await settle();
  schedule(v, 'one two', speech);
  await settle();
  schedule(v, 'one two three', speech);
  await settle();

  assert.deepEqual(session.sent, ['one', 'two', 'three']);
});

test('a re-delivered transcript is not answered twice', async () => {
  // ElevenLabs re-delivers a transcript it believes went unanswered. Answering
  // again repeats Beth's reply and spends a second turn on the same question.
  const session = fakeSession();
  const v = new VoiceService(cfg(), new ConversationBus(), session as never);
  const speech = fakeSpeech();

  schedule(v, 'what is in flight?', speech);
  await settle();
  assert.equal(session.sent.length, 1);

  schedule(v, 'what is in flight?', speech);
  await settle();
  assert.equal(session.sent.length, 1, 'the duplicate was dropped');
});

test('a genuinely new utterance after one was answered still runs', async () => {
  const session = fakeSession();
  const v = new VoiceService(cfg(), new ConversationBus(), session as never);
  const speech = fakeSpeech();

  schedule(v, 'first question', speech);
  await settle();
  schedule(v, 'second question', speech);
  await settle();
  assert.deepEqual(session.sent, ['first question', 'second question']);
});

/**
 * Announcement queueing. The failure these cover is the one Danny hit: a ship
 * that worked and that he never heard. Work outlives the client's idle window,
 * the paid session closes mid-job, and the closing line lands with no channel
 * open. Silently dropping it made the most valuable results the least audible.
 */

/** Reach into the private queue/flush the way `schedule` reaches into scheduleTurn. */
const priv = (v: VoiceService) =>
  v as unknown as {
    pendingAnnouncements: { text: string; at: number }[];
    flushAnnouncements(): void;
    liveSession: unknown;
  };

/** Speech session that records what it was asked to say. */
function recordingSpeech() {
  const spoken: string[] = [];
  return { spoken, sendResponse: async (t: string) => void spoken.push(t) };
}

test('a line produced with no voice session is spoken once one opens', async () => {
  const bus = new ConversationBus();
  const v = new VoiceService(cfg(), bus, fakeSession() as never);
  const speech = recordingSpeech();

  bus.publish({ type: 'say', kind: 'status', text: 'Plan 157 is shipped.' } as never);
  assert.equal(priv(v).pendingAnnouncements.length, 1, 'held rather than dropped');

  // The session arrives (onInit does exactly this, then flushes).
  priv(v).liveSession = speech;
  priv(v).flushAnnouncements();
  await settle(20);

  assert.deepEqual(speech.spoken, ['Plan 157 is shipped.']);
  assert.equal(priv(v).pendingAnnouncements.length, 0, 'queue drains');
});

test('a live session speaks immediately and queues nothing', async () => {
  const bus = new ConversationBus();
  const v = new VoiceService(cfg(), bus, fakeSession() as never);
  const speech = recordingSpeech();
  priv(v).liveSession = speech;

  bus.publish({ type: 'assistant', text: 'Suites are green.' } as never);
  await settle(20);

  assert.deepEqual(speech.spoken, ['Suites are green.']);
  assert.equal(priv(v).pendingAnnouncements.length, 0);
});

test('stale news is dropped rather than blurted out late', async () => {
  const bus = new ConversationBus();
  const v = new VoiceService(cfg(), bus, fakeSession() as never);
  const speech = recordingSpeech();

  bus.publish({ type: 'say', kind: 'status', text: 'old news' } as never);
  // Age it past the freshness window — the browser never opened a session.
  priv(v).pendingAnnouncements[0].at = Date.now() - 10 * 60_000;

  priv(v).liveSession = speech;
  priv(v).flushAnnouncements();
  await settle(20);

  assert.deepEqual(speech.spoken, [], 'ten-minute-old news is worse than silence');
});

test('the queue keeps the NEWEST lines when work outruns the channel', async () => {
  const bus = new ConversationBus();
  const v = new VoiceService(cfg(), bus, fakeSession() as never);
  const speech = recordingSpeech();

  for (let i = 1; i <= 9; i++) bus.publish({ type: 'say', kind: 'status', text: `line ${i}` } as never);

  priv(v).liveSession = speech;
  priv(v).flushAnnouncements();
  await settle(20);

  assert.equal(speech.spoken.length, 6, 'capped, not a monologue');
  assert.equal(speech.spoken[0], 'line 4', 'oldest was dropped first');
  assert.equal(speech.spoken.at(-1), 'line 9', 'the latest word survives');
});

test('two spoken turns never stream at once', async () => {
  // Each sendResponse ends by sending the is_final marker, so two overlapping
  // ones make whichever finishes first close the agent turn — the rest of the
  // other answer is discarded unheard. This is the mechanism behind "she said
  // 'Let me check the evidence on disk' and then nothing".
  const session = fakeSession();
  const v = new VoiceService(cfg(), new ConversationBus(), session as never);

  let concurrent = 0;
  let maxConcurrent = 0;
  const slowSpeech = {
    sendResponse: async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 80));
      concurrent--;
    },
  };

  schedule(v, 'first question', slowSpeech);
  await settle(60);
  schedule(v, 'a completely different second question', slowSpeech);
  await settle(400);

  assert.equal(maxConcurrent, 1, 'responses must be chained, never concurrent');
  assert.equal(session.sent.length, 2, 'both turns still reach the director');
});

test('after the socket drops, the next line queues instead of vanishing', async () => {
  // The close path that actually happens: the browser ends the session, the
  // websocket drops, and the SDK emits `disconnected` — NOT `close`, which is
  // only sent for an explicit protocol close. Wiring just `close` left
  // liveSession pointing at a dead session, so nothing queued and sendResponse
  // threw into a catch: the announcement fix silently did not apply to the most
  // common ending.
  const bus = new ConversationBus();
  const v = new VoiceService(cfg(), bus, fakeSession() as never);
  const speech = recordingSpeech();
  priv(v).liveSession = speech;

  bus.publish({ type: 'say', kind: 'status', text: 'heard this one' } as never);
  await settle(20);
  assert.deepEqual(speech.spoken, ['heard this one']);

  (v as unknown as { teardownSession(): void }).teardownSession();
  assert.equal(priv(v).liveSession, null, 'a dropped socket must not leave a stale session');

  bus.publish({ type: 'say', kind: 'status', text: 'said after the drop' } as never);
  await settle(20);
  assert.deepEqual(
    priv(v).pendingAnnouncements.map((a) => a.text),
    ['said after the drop'],
    'queued for the next session rather than dropped'
  );
});

test('teardown is idempotent — both callbacks may fire for one ending', async () => {
  const v = new VoiceService(cfg(), new ConversationBus(), fakeSession() as never);
  const t = v as unknown as { teardownSession(): void };
  t.teardownSession();
  t.teardownSession();
  assert.equal(priv(v).liveSession, null);
});

test('the settled turn goes through sendPointed, so a clicked plan reaches voice', async () => {
  const session = fakeSession();
  let pointedCalls = 0;
  session.sendPointed = (t: string) => {
    pointedCalls++;
    session.sent.push(t);
    return pointedCalls;
  };
  const v = new VoiceService(cfg(), new ConversationBus(), session as never);
  schedule(v, 'what is left on this?', fakeSpeech());
  await settle();
  assert.equal(pointedCalls, 1);
});
