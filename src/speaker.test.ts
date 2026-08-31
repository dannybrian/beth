// The playback queue, driven by a stubbed <audio> — the same trade as
// listen.test.ts: browser code is testable when the hard part is bookkeeping.
// Every case here is a failure that was, or would be, invisible in the page: a
// wedged queue looks like her going quiet, a swallowed backlog looks like the
// mute working, and a deliberate stop reported as an error looks like a bug
// directly under the line saying she stopped.
import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — browser module, plain JS on purpose (see ui/listen.js precedent)
import { createSpeaker } from '../ui/speaker.js';

/** An <audio> whose outcomes the test scripts: 'play' | AbortError | NotAllowedError. */
function fakeAudio() {
  const handlers: Record<string, (() => void)[]> = {};
  return {
    src: '',
    volume: 1,
    paused: false,
    nextPlay: 'play' as 'play' | 'abort' | 'blocked',
    addEventListener(ev: string, fn: () => void) {
      (handlers[ev] ??= []).push(fn);
    },
    fire(ev: string) {
      for (const fn of handlers[ev] ?? []) fn();
    },
    play() {
      this.paused = false;
      if (this.nextPlay === 'abort') return Promise.reject(Object.assign(new Error('interrupted by pause()'), { name: 'AbortError' }));
      if (this.nextPlay === 'blocked') return Promise.reject(Object.assign(new Error('user gesture required'), { name: 'NotAllowedError' }));
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
  };
}

function rig(over: any = {}) {
  const audio = fakeAudio();
  const notes: string[] = [];
  const ear: string[] = [];
  const reports: string[][] = [];
  const s = createSpeaker({
    audio,
    note: (t: string) => notes.push(t),
    park: () => ear.push('park'),
    unpark: () => ear.push('unpark'),
    report: (ids: string[]) => reports.push(ids),
    ...over,
  });
  return { audio, notes, ear, reports, s };
}

const flush = () => new Promise((r) => setImmediate(r));

test('lines play one at a time and the ear parks for the duration', async () => {
  const { audio, ear, s } = rig();
  s.enqueue('s1');
  s.enqueue('s2');
  assert.match(audio.src, /say\/s1$/, 'the second line waits its turn');
  assert.deepEqual(ear, ['park']);
  audio.fire('ended');
  assert.match(audio.src, /say\/s2$/);
  // ⚠️ No unpark between queued lines — the ear would open into the gap and
  // hear the second one.
  assert.deepEqual(ear, ['park', 'park']);
  audio.fire('ended');
  assert.deepEqual(ear, ['park', 'park', 'unpark']);
  assert.equal(s.isSpeaking(), false);
});

test('stop drops the backlog, says how many, and never reports the AbortError', async () => {
  const { audio, notes, s } = rig();
  s.enqueue('s1');
  s.enqueue('s2');
  // The race the mute test flushed out: pause() lands while play() resolves.
  audio.nextPlay = 'abort';
  s.stop();
  await flush();
  assert.equal(audio.paused, true);
  assert.equal(s.isSpeaking(), false);
  assert.deepEqual(notes, ['⏹ stopped speaking — 1 line not read aloud'], 'no 🔇 under the stop line');
  s.enqueue('s3');
  assert.match(audio.src, /say\/s3$/, 'the queue is not wedged after a stop');
});

test('autoplay refusal is reported in as many words, and the queue advances', async () => {
  const { audio, notes, s } = rig();
  audio.nextPlay = 'blocked';
  s.enqueue('s1');
  await flush();
  assert.match(notes[0], /click the page once to allow audio/);
  assert.equal(s.isSpeaking(), false, 'a refused line must not wedge the queue');
});

test('an element error advances instead of wedging', () => {
  const { audio, ear, s } = rig();
  s.enqueue('s1');
  s.enqueue('s2');
  audio.fire('error');
  assert.match(audio.src, /say\/s2$/);
  audio.fire('error');
  assert.equal(s.isSpeaking(), false);
  assert.equal(ear.filter((e) => e === 'unpark').length, 1);
});

// --- the playback report ------------------------------------------------------
//
// The harness holds the MACHINE's talking stick while its published lines are
// unplayed (src/speakOut.ts). Every way a line can end must therefore reach
// `report`, because an unreported ending holds every other beth on the machine
// quiet until the backstop — a failure with no symptom on THIS page at all.

test('every ending reports: played, refused, and errored lines all reach report', async () => {
  const { audio, reports, s } = rig();
  s.enqueue('s1');
  audio.fire('ended');
  assert.deepEqual(reports, [['s1']]);
  audio.nextPlay = 'blocked';
  s.enqueue('s2');
  await flush();
  audio.nextPlay = 'play';
  s.enqueue('s3');
  audio.fire('error');
  assert.deepEqual(reports, [['s1'], ['s2'], ['s3']]);
});

test('stop reports the cut line AND the dropped backlog in one call', async () => {
  const { audio, reports, s } = rig();
  s.enqueue('s1');
  s.enqueue('s2');
  s.enqueue('s3');
  audio.nextPlay = 'abort';
  s.stop();
  await flush();
  // The whole abandoned thought at once — the stick must not stay held for
  // words nobody will hear.
  assert.deepEqual(reports, [['s1', 's2', 's3']]);
  // And a stop with nothing in flight reports nothing at all.
  s.stop();
  assert.deepEqual(reports, [['s1', 's2', 's3']]);
});

test('volume clamps at both ends and zero still plays', () => {
  const { audio, s } = rig({ initialVolume: 1.7 });
  assert.equal(s.volume(), 1);
  s.setVolume(-3);
  assert.equal(audio.volume, 0);
  s.enqueue('s1');
  assert.match(audio.src, /say\/s1$/, 'mute is a volume, not a gate — the line still fetches (and bills)');
});
