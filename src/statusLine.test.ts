// The bottom-of-terminal line, against a stubbed stream and console.
//
// Its failures are all cosmetic-looking and all wrong: a log line printed on
// top of the status text (the tail of `beth: repo` left on the row), a spinner
// that keeps spinning after the turn ended (reads as a hang), control bytes in
// a piped log, and a timer that keeps the process alive on Ctrl-C.
import test from 'node:test';
import assert from 'node:assert/strict';
import { StatusLine } from './statusLine.ts';

const CLEAR = '\r\x1b[2K';

function stub(isTTY = true) {
  const writes: string[] = [];
  const out = { isTTY, write: (s: string) => void writes.push(s) };
  const ticks: Array<() => void> = [];
  let unrefs = 0;
  const timers = {
    setInterval: (fn: () => void) => { ticks.push(fn); return { unref: () => void unrefs++ }; },
    clearInterval: (h: unknown) => void ticks.splice(0, ticks.length),
  };
  const con = { log: (...a: unknown[]) => void writes.push(`LOG ${a.join(' ')}\n`), warn: (...a: unknown[]) => void writes.push(`WARN ${a.join(' ')}\n`), error: (...a: unknown[]) => void writes.push(`ERR ${a.join(' ')}\n`) };
  return { writes, out, timers, con, ticks, unrefs: () => unrefs };
}

test('idle: the label, redrawn in place, no newline', () => {
  const s = stub();
  const line = new StatusLine({ label: 'beadgame', out: s.out, timers: s.timers });
  line.show();
  assert.deepEqual(s.writes, [`${CLEAR}beth: beadgame`]);
  assert.ok(!s.writes.join('').includes('\n'));
});

test('busy: a spinner frame appears, advances on tick, and goes when the turn ends', () => {
  const s = stub();
  const line = new StatusLine({ label: 'beadgame', out: s.out, timers: s.timers });
  line.setBusy(true);
  assert.match(s.writes.at(-1)!, /^\r\x1b\[2K⠋ beth: beadgame$/);
  assert.equal(s.unrefs(), 1, 'the interval must not keep the process alive');
  s.ticks[0]();
  assert.match(s.writes.at(-1)!, /⠙ beth: beadgame$/);
  line.setBusy(false);
  assert.equal(s.writes.at(-1), `${CLEAR}beth: beadgame`);
  assert.equal(s.ticks.length, 0, 'interval cleared');
  assert.equal(line.busy, false);
});

test('setBusy is idempotent: two starts make one interval, a stop while idle writes nothing', () => {
  const s = stub();
  const line = new StatusLine({ label: 'r', out: s.out, timers: s.timers });
  line.setBusy(true);
  line.setBusy(true);
  assert.equal(s.ticks.length, 1);
  line.setBusy(false);
  const n = s.writes.length;
  line.setBusy(false);
  assert.equal(s.writes.length, n);
});

test('a console line lands ABOVE the status line, which is redrawn after it', () => {
  const s = stub();
  const line = new StatusLine({ label: 'beadgame', out: s.out, timers: s.timers });
  const undo = line.install(s.con);
  line.show();
  s.writes.length = 0;
  s.con.log('  work: 3 items');
  assert.deepEqual(s.writes, [CLEAR, 'LOG   work: 3 items\n', `${CLEAR}beth: beadgame`]);
  undo();
  s.writes.length = 0;
  s.con.log('plain');
  assert.deepEqual(s.writes, ['LOG plain\n'], 'restored console writes nothing else');
});

test('a console line BEFORE show() is untouched', () => {
  const s = stub();
  const line = new StatusLine({ label: 'r', out: s.out, timers: s.timers });
  line.install(s.con);
  s.con.warn('boot');
  assert.deepEqual(s.writes, ['WARN boot\n']);
});

test('stop clears the line, stops the spinner, and restores the console', () => {
  const s = stub();
  const line = new StatusLine({ label: 'r', out: s.out, timers: s.timers });
  line.install(s.con);
  line.setBusy(true);
  s.writes.length = 0;
  line.stop();
  assert.deepEqual(s.writes, [CLEAR]);
  assert.equal(s.ticks.length, 0);
  s.con.log('after');
  assert.deepEqual(s.writes, [CLEAR, 'LOG after\n']);
});

test('not a TTY: nothing is written and the console is left alone', () => {
  const s = stub(false);
  const line = new StatusLine({ label: 'r', out: s.out, timers: s.timers });
  const undo = line.install(s.con);
  line.show();
  line.setBusy(true);
  line.tick();
  s.con.log('x');
  line.stop();
  undo();
  assert.deepEqual(s.writes, ['LOG x\n']);
  assert.equal(s.ticks.length, 0);
});
