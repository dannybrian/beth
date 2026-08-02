// The ear, driven by a stubbed recogniser.
//
// `ui/listen.js` is browser code, but the part that goes wrong is not the browser
// — it is the bookkeeping across a recogniser that Chrome ends underneath us. A
// fake SpeechRecognition reproduces that exactly, and it is the only way to test
// the bug Danny actually hit: talk for more than about twenty seconds and the
// composer resets, refilled with only the tail of your own sentence.
import test from 'node:test';
import assert from 'node:assert/strict';

/** Every instance Chrome would have handed us, in order. */
const made: any[] = [];

class FakeRecognition {
  onresult: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  onend: (() => void) | null = null;
  continuous = false;
  interimResults = false;
  lang = '';
  results: any[] = [];
  constructor() {
    made.push(this);
  }
  start() {}
  stop() {
    this.onend?.();
  }
  /** Deliver one more chunk of the utterance. */
  hear(transcript: string, isFinal = false) {
    this.results.push(Object.assign([{ transcript }], { isFinal }));
    this.onresult?.({ results: this.results });
  }
  /** What Chrome does on its own schedule, mid-sentence and without warning. */
  endSession() {
    this.onend?.();
  }
}

(globalThis as any).window = { SpeechRecognition: FakeRecognition };
const { Listener } = await import('../ui/listen.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function listening(settleMs = 60) {
  made.length = 0;
  const interim: string[] = [];
  const settled: string[] = [];
  const l = new Listener({
    settleMs,
    onInterim: (t: string) => interim.push(t),
    onSettled: (t: string) => settled.push(t),
    isSpeaking: () => false,
  });
  // arm() wants a microphone and an AudioContext; the recogniser is the part
  // under test, so start it directly.
  (l as any).mode = 'listening';
  l.startRec();
  return { l, interim, settled };
}

test('a sentence SURVIVES the recogniser being restarted under it', async () => {
  // Chrome ends a session on its own schedule and the next one starts with empty
  // results. Without carrying, the composer showed only what was said after the
  // seam — his words reset and refilled with their own tail.
  const { interim, settled } = listening();
  made[0].hear('I have been thinking about', false);
  assert.equal(interim.at(-1), 'I have been thinking about');

  made[0].endSession();
  assert.equal(made.length, 2, 'a fresh recogniser takes over');

  made[1].hear(' the voice plane', true);
  assert.equal(interim.at(-1), 'I have been thinking about the voice plane');

  await sleep(120);
  assert.deepEqual(settled, ['I have been thinking about the voice plane']);
});

test('three sessions still make ONE utterance', async () => {
  const { settled } = listening();
  made[0].hear('one', false);
  made[0].endSession();
  made[1].hear(' two', false);
  made[1].endSession();
  made[2].hear(' three', true);
  await sleep(120);
  assert.deepEqual(settled, ['One two three']);
});

test('the NEXT sentence does not inherit the last one', async () => {
  // The carry has to be dropped when the window fires, or every utterance grows
  // by everything said before it.
  const { settled } = listening();
  made[0].hear('first thing', true);
  await sleep(120);
  made[0].hear(' second thing', true);
  await sleep(120);
  assert.deepEqual(settled, ['First thing', 'Second thing']);
});

test('a restart AFTER the window fires carries nothing', async () => {
  const { settled } = listening();
  made[0].hear('all of it', true);
  await sleep(120);
  made[0].endSession();
  made[1].hear('new sentence', true);
  await sleep(120);
  assert.deepEqual(settled, ['All of it', 'New sentence']);
});

test('parking for her voice ends the utterance rather than seaming it', async () => {
  // Half duplex is a boundary between utterances: what was said before she spoke
  // must not be glued to what is said after.
  const { l, settled } = listening();
  made[0].hear('before she spoke', true);
  await sleep(120);
  (l as any).park();
  (l as any).unpark();
  await sleep(400);
  const fresh = made.at(-1);
  fresh.hear('after she spoke', true);
  await sleep(120);
  assert.deepEqual(settled, ['Before she spoke', 'After she spoke']);
});

test('the window waits for the WORDS to stop changing, not the events', async () => {
  // Chrome fires onresult continuously while it revises its own guess, and
  // restarting the timer per event let a fiddling recogniser hold a finished
  // sentence indefinitely.
  const { settled } = listening(150);
  made[0].hear('steady', false);
  for (let i = 0; i < 6; i++) {
    await sleep(40);
    made[0].onresult?.({ results: made[0].results }); // same words, again
  }
  await sleep(60);
  assert.deepEqual(settled, ['Steady'], 'fired on schedule despite the churn');
});
