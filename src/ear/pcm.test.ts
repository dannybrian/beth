// The downsampler as pure math. This is capture-path code where a mistake is
// INVISIBLE — a resampler that drifts or warbles does not error, it makes her
// mishear him — so the properties tested are the ones that fail silently:
// continuity across chunk boundaries, rate accuracy over time, and clipping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Downsampler, Batcher, clamp16 } from '../../ui/pcm.js';

test('3:1 decimation lands the right number of samples over time', () => {
  const d = new Downsampler(48000, 16000);
  let out = 0;
  // A second of audio in awkwardly-sized chunks, like a worklet delivers.
  for (let i = 0; i < 375; i++) out += d.push(new Float32Array(128)).length;
  assert.ok(Math.abs(out - 16000) <= 2, `expected ~16000 samples, got ${out}`);
});

test('chunk boundaries do not change the output', () => {
  // The same signal, whole vs split — a resampler that resets its fractional
  // position at each boundary produces different samples near the seams, which
  // is the warble bug. 44100→16000 makes the step fractional on purpose.
  const signal = Float32Array.from({ length: 4410 }, (_, i) => Math.sin(i / 7));
  const whole = new Downsampler(44100, 16000).push(signal);
  const split = new Downsampler(44100, 16000);
  const parts = [
    ...split.push(signal.subarray(0, 100)),
    ...split.push(signal.subarray(100, 1101)),
    ...split.push(signal.subarray(1101, 1102)),
    ...split.push(signal.subarray(1102)),
  ];
  assert.deepEqual(Array.from(whole), parts);
});

test('clipping: AGC overshoot clamps instead of wrapping', () => {
  assert.equal(clamp16(1.7), 0x7fff);
  assert.equal(clamp16(-1.7), -0x8000);
  assert.equal(clamp16(0), 0);
  // Wrapping is the invisible version of this bug: 1.1 would come out as a
  // large NEGATIVE sample and the audio would sound like crackle, not error.
  assert.ok(clamp16(1.1) > 0);
});

test('upsampling is refused rather than invented', () => {
  assert.throws(() => new Downsampler(8000, 16000));
});

test('batcher emits exact parcels and keeps the remainder', () => {
  const got: number[][] = [];
  const b = new Batcher(4, (batch: Int16Array) => got.push(Array.from(batch)));
  b.push(Int16Array.from([1, 2, 3]));
  assert.equal(got.length, 0, 'nothing until a parcel is full');
  b.push(Int16Array.from([4, 5, 6, 7, 8, 9]));
  assert.deepEqual(got, [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
  ]);
  b.flush();
  assert.deepEqual(got[2], [9], 'flush hands over the tail');
  b.flush();
  assert.equal(got.length, 3, 'an empty flush emits nothing');
});
