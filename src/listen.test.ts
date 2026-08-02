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

// --- not sending is a feature ------------------------------------------------
//
// Recognition is wrong often enough that "don't send that" has to be a control.
// Both of these are guarantees about the seconds between bad words appearing and
// the window closing.

test('turning the ear off NEVER sends what it was holding', async () => {
  // Reaching for the mic is what he does when the transcription is going wrong,
  // so switching it off has to be a way out of the sentence, not a commit of it.
  const { l, settled } = listening();
  made[0].hear('this came out as nonsense', true);
  await l.off();
  await sleep(200);
  assert.deepEqual(settled, [], 'the window was open and closed empty');
});

test('abandon drops the utterance without closing the ear', async () => {
  const { l, settled, interim } = listening();
  made[0].hear('utter nonsense', true);
  (l as any).abandon();
  await sleep(200);
  assert.deepEqual(settled, []);

  // ⚠️ The recogniser still holds the abandoned words. Cancelling the timer
  // alone would let its next result render them straight back into the composer.
  made[0].hear(' and now the real sentence', true);
  await sleep(120);
  assert.deepEqual(settled, ['And now the real sentence']);
  assert.ok(
    !interim.at(-1)!.toLowerCase().includes('utter nonsense'),
    `the thrown-away words came back: "${interim.at(-1)}"`
  );
});

test('abandoning does not swallow a recogniser Chrome swapped in underneath', async () => {
  // Same test the settle callback makes, for the same reason: by the time you hit
  // Stop, Chrome may have handed us a DIFFERENT instance. Spending its count
  // against the old one's would eat the first words of the next sentence.
  const { l, settled } = listening();
  made[0].hear('the words being thrown away', false);
  made[0].endSession();
  (l as any).abandon();
  await sleep(200);
  assert.deepEqual(settled, [], 'the abandon itself still cancels');

  made[1].hear('a whole new sentence', true);
  await sleep(120);
  assert.deepEqual(settled, ['A whole new sentence'], 'nothing was consumed by mistake');
});

// --- keyterm biasing ---------------------------------------------------------
//
// Contextual biasing arrived in the Web Speech API after the voice plane was
// written. It is an ENHANCEMENT on a path that already worked, so every test here
// is really about the same thing: it must not be able to cost us the ear.

class FakePhrase {
  phrase: string;
  boost: number;
  constructor(phrase: string, boost: number) {
    this.phrase = phrase;
    this.boost = boost;
  }
}

/** Chrome exposes `phrases` on the prototype; the stub has to as well. */
function withPhraseSupport(fn: () => void | Promise<void>) {
  (FakeRecognition.prototype as any).phrases = undefined;
  (globalThis as any).window.SpeechRecognitionPhrase = FakePhrase;
  return (async () => {
    try {
      await fn();
    } finally {
      delete (FakeRecognition.prototype as any).phrases;
      delete (globalThis as any).window.SpeechRecognitionPhrase;
    }
  })();
}

const biasing = (over: Record<string, unknown> = {}) => {
  made.length = 0;
  const state: string[] = [];
  const l = new Listener({
    settleMs: 60,
    phrases: ['colyseus', 'Music Core'],
    boost: 3,
    onState: (_s: string, detail: string) => detail && state.push(detail),
    onInterim: () => {},
    onSettled: () => {},
    isSpeaking: () => false,
    ...over,
  });
  (l as any).mode = 'listening';
  l.startRec();
  return { l, state };
};

test('the vocabulary reaches the recogniser, boosted', () =>
  withPhraseSupport(() => {
    biasing();
    assert.deepEqual(
      made[0].phrases.map((p: FakePhrase) => [p.phrase, p.boost]),
      [['colyseus', 3], ['Music Core', 3]]
    );
  }));

// ⚠️ The seam. Chrome ends a session on its own schedule, and biasing set only on
// the first instance would quietly stop applying twenty seconds into a sentence —
// exactly as invisible as the bug the `carry` fix exists for.
test('EVERY recogniser is biased, not just the first', () =>
  withPhraseSupport(() => {
    biasing();
    made[0].endSession();
    assert.equal(made.length, 2, 'a fresh recogniser took over');
    assert.deepEqual(made[1].phrases.map((p: FakePhrase) => p.phrase), ['colyseus', 'Music Core']);
  }));

test('a browser without the hook still listens', () => {
  // No `phrases` on the prototype and no constructor: the ordinary case for any
  // Chrome older than the feature, and it must be a non-event.
  const { l } = biasing();
  assert.equal(made.length, 1);
  assert.equal(made[0].phrases, undefined);
  assert.equal((l as any).biasingRefused, false, 'nothing was refused — there was nothing to refuse');
});

test('a recogniser that REFUSES the vocabulary is restarted without it', () =>
  withPhraseSupport(() => {
    // The failure that would otherwise be a dead mic: Chrome ties biasing to a
    // model that is not installed, and start() throws.
    let thrown = false;
    const original = FakeRecognition.prototype.start;
    FakeRecognition.prototype.start = function (this: any) {
      if (this.phrases?.length && !thrown) {
        thrown = true;
        throw new Error('phrases require on-device recognition');
      }
    };
    try {
      const { l, state } = biasing();
      assert.equal(made.length, 2, 'it tried again');
      assert.equal(made[1].phrases, undefined, 'and plainly the second time');
      assert.equal((l as any).biasingRefused, true, 'latched — no retry loop');
      assert.match(state.join(' '), /biasing refused/i, 'and it said so rather than downgrading silently');
    } finally {
      FakeRecognition.prototype.start = original;
    }
  }));

test('nothing here calls install() — a model download is not the page\'s decision', () => {
  const SR = (globalThis as any).window.SpeechRecognition;
  let installs = 0;
  SR.install = () => (installs++, Promise.resolve(true));
  SR.available = () => Promise.resolve('downloadable');
  try {
    biasing();
    assert.equal(installs, 0);
  } finally {
    delete SR.install;
    delete SR.available;
  }
});
