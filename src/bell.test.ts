// The end-of-turn tone, against a stubbed AudioContext.
//
// Both failures are silent. A context that never resumes is a bell that simply
// never rings — browsers hand it to you suspended until a gesture — and a
// double-fire rings twice on one turn. Neither throws, and neither is visible on
// the page that caused it.
import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — browser module, plain JS on purpose
import { createBell } from '../ui/bell.js';

function stubCtx() {
  const made: any = { osc: 0, gain: 0, resumed: 0 };
  class Ctx {
    state = 'suspended';
    currentTime = 0;
    destination = {};
    resume() {
      made.resumed++;
      this.state = 'running';
    }
    createGain() {
      made.gain++;
      return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
    createOscillator() {
      made.osc++;
      return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} };
    }
  }
  return { Ctx, made };
}

test('a suspended context is resumed, or it never sounds', () => {
  const { Ctx, made } = stubCtx();
  const bell = createBell({ AudioContext: Ctx as any });
  assert.equal(bell.ring(1), true);
  assert.ok(made.resumed >= 1, 'resume() must be called — suspended is the default');
  assert.equal(made.osc, 2, 'two partials, which is what makes it a bell not a beep');
});

test('two turns landing together ring once', () => {
  const { Ctx, made } = stubCtx();
  const bell = createBell({ AudioContext: Ctx as any });
  assert.equal(bell.ring(1), true);
  const after = made.osc;
  assert.equal(bell.ring(1), false, 'the second is swallowed');
  assert.equal(made.osc, after, 'and builds nothing');
});

test('volume zero is silence, not a quiet bell', () => {
  const { Ctx, made } = stubCtx();
  const bell = createBell({ AudioContext: Ctx as any });
  assert.equal(bell.ring(0), false);
  assert.equal(made.osc, 0);
});

test('no Web Audio at all degrades to nothing, never to a throw', () => {
  const bell = createBell({ AudioContext: undefined });
  assert.equal(bell.ring(1), false);
  assert.equal(bell.unlock(), null);
});
