// The credit countdown. The failures worth testing are the quiet ones: cycle
// math that drifts a day (a countdown that resets early looks like a refund),
// a meter counting while the plan still covers usage (a bill for money never
// drawn), and two beths whose appends eat each other. Money that is only an
// estimate must still be an exactly-computed estimate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CreditLedger, CreditMeter, anyWindowExhausted, cycleStart, nextReset } from './creditMeter.ts';

const dirFor = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-credits-'));

// --- cycle math ---------------------------------------------------------------

test('the cycle starts at the latest reset day at or before now', () => {
  assert.equal(cycleStart(1, new Date(2026, 7, 30)).getTime(), new Date(2026, 7, 1).getTime());
  // Standing ON the reset day: the new cycle began today.
  assert.equal(cycleStart(15, new Date(2026, 7, 15)).getTime(), new Date(2026, 7, 15).getTime());
  // Before this month's reset day: still the previous month's cycle.
  assert.equal(cycleStart(15, new Date(2026, 7, 10)).getTime(), new Date(2026, 6, 15).getTime());
});

test('a reset day that short months do not have clamps instead of drifting', () => {
  // Anchor 31, standing in early March: February's reset happened on the 28th,
  // not on "the 31st" (which would roll into March and un-happen).
  assert.equal(cycleStart(31, new Date(2026, 2, 5)).getTime(), new Date(2026, 1, 28).getTime());
  assert.equal(nextReset(31, new Date(2026, 2, 5)).getTime(), new Date(2026, 2, 31).getTime());
});

test('nextReset is the following cycle boundary', () => {
  assert.equal(nextReset(1, new Date(2026, 7, 30)).getTime(), new Date(2026, 8, 1).getTime());
  assert.equal(nextReset(15, new Date(2026, 7, 15)).getTime(), new Date(2026, 8, 15).getTime());
});

// --- the exhaustion read ------------------------------------------------------

test('exhaustion arms on ANY window at 100, and never on an absent plan', () => {
  assert.equal(anyWindowExhausted(null), false);
  assert.equal(anyWindowExhausted({ rate_limits_available: false }), false, 'an API-key session has no windows to exhaust');
  assert.equal(
    anyWindowExhausted({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 99.9 } } }),
    false
  );
  assert.equal(
    anyWindowExhausted({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 100 } } }),
    true
  );
  assert.equal(
    anyWindowExhausted({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 12 }, model_scoped: [{ utilization: 100 }] },
    }),
    true
  );
  // Read defensively — a window with no utilization number is not an armed one.
  assert.equal(
    anyWindowExhausted({ rate_limits_available: true, rate_limits: { five_hour: {}, seven_day: null } }),
    false
  );
});

// --- the ledger ---------------------------------------------------------------

test('two beths append to one ledger, and the sum is the machine total', () => {
  const dir = dirFor();
  const a = new CreditLedger(dir, 1);
  const b = new CreditLedger(dir, 1);
  a.add(0.5, 'beadgame');
  b.add(0.25, 'harness');
  a.add(0.25, 'beadgame');
  assert.equal(a.spentUsd(), 1);
  assert.equal(b.spentUsd(), 1, 'both readers see the same machine-wide truth');
});

test('a corrupt line loses one turn, never the ledger', () => {
  const dir = dirFor();
  const ledger = new CreditLedger(dir, 1);
  ledger.add(0.5, 'x');
  const file = fs.readdirSync(dir).find((f) => f.startsWith('credits-'))!;
  fs.appendFileSync(path.join(dir, file), 'torn-half-of-a-li\n');
  ledger.add(0.5, 'x');
  assert.equal(ledger.spentUsd(), 1);
});

test('zero and negative turns are not entries', () => {
  const dir = dirFor();
  const ledger = new CreditLedger(dir, 1);
  ledger.add(0, 'x');
  ledger.add(-1, 'x');
  ledger.add(NaN, 'x');
  assert.equal(ledger.spentUsd(), 0);
  assert.equal(fs.readdirSync(dir).length, 0, 'nothing worth a file was said');
});

test('old cycles are swept; the current and previous survive', () => {
  const dir = dirFor();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'credits-2020-01-01.jsonl'), '{"usd":9,"repo":"ancient"}\n');
  const ledger = new CreditLedger(dir, 1);
  ledger.add(0.5, 'x');
  assert.equal(fs.existsSync(path.join(dir, 'credits-2020-01-01.jsonl')), false, 'an old cycle is dead weight');
  assert.equal(ledger.spentUsd(), 0.5);
});

test('spend lands in the cycle of its moment, and a new cycle starts at zero', () => {
  const dir = dirFor();
  const ledger = new CreditLedger(dir, 1);
  const july = new Date(2026, 6, 20);
  const august = new Date(2026, 7, 20);
  ledger.add(3, 'x', july);
  assert.equal(ledger.spentUsd(july), 3);
  assert.equal(ledger.spentUsd(august), 0, 'a reset is a refill, not a carry');
});

// --- the meter ----------------------------------------------------------------

test('nothing is counted while the plan still covers usage', async () => {
  const dir = dirFor();
  let asked = 0;
  const m = new CreditMeter({
    monthlyUsd: 50,
    resetDay: 1,
    repo: 'x',
    dir,
    checkMs: 0,
    exhausted: async () => (asked++, false),
  });
  await m.noteTurn(1);
  assert.ok(asked > 0);
  assert.equal(m.state().spentUsd, 0, 'metering covered turns would bill money never drawn');
});

test('once a window is exhausted, turns count and the countdown moves', async () => {
  const dir = dirFor();
  const m = new CreditMeter({ monthlyUsd: 50, resetDay: 1, repo: 'x', dir, checkMs: 0, exhausted: async () => true });
  await m.noteTurn(1.25);
  await m.noteTurn(0.75);
  const s = m.state();
  assert.equal(s.available, true);
  assert.equal(s.spentUsd, 2);
  assert.equal(s.remainingUsd, 48);
  assert.equal(s.armed, true);
});

test('the exhaustion check is cached — one SDK read, not one per turn', async () => {
  const dir = dirFor();
  let asked = 0;
  const m = new CreditMeter({
    monthlyUsd: 50,
    resetDay: 1,
    repo: 'x',
    dir,
    checkMs: 60_000,
    exhausted: async () => (asked++, true),
  });
  await m.noteTurn(1);
  await m.noteTurn(1);
  await m.noteTurn(1);
  assert.equal(asked, 1);
  assert.equal(m.state().spentUsd, 3);
});

test('a failing exhaustion read means NOT armed — never a guessed bill', async () => {
  const dir = dirFor();
  const m = new CreditMeter({
    monthlyUsd: 50,
    resetDay: 1,
    repo: 'x',
    dir,
    checkMs: 0,
    exhausted: async () => {
      throw new Error('no session');
    },
  });
  await m.noteTurn(1);
  assert.equal(m.state().spentUsd, 0);
});

test('no budget, no meter — state says unavailable and noteTurn is free', async () => {
  const dir = dirFor();
  let asked = 0;
  const m = new CreditMeter({ monthlyUsd: 0, resetDay: 1, repo: 'x', dir, checkMs: 0, exhausted: async () => (asked++, true) });
  await m.noteTurn(5);
  assert.deepEqual(m.state(), { available: false });
  assert.equal(asked, 0, 'an unconfigured meter must not spend SDK reads');
});
