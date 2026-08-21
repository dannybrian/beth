// The wire panel's math, in node — the part that renders PLAUSIBLY WRONG with
// no error anywhere. An anatomy strip whose segments land off by a request
// looks like a fact about the turn; a token summary that double-counts looks
// like an expensive conversation. The DOM around these is dumb on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — browser module, plain JS on purpose
import { groupTurns, anatomySpans, tokenSummary, fmtTok, fmtMs } from '../ui/wire.js';

const T = 1_000_000;
const fixture = [
  { seq: 1, ts: T, turn: 14, kind: 'user', text: 'ship it' },
  {
    seq: 2, ts: T + 4000, turn: 14, kind: 'request', startAt: T + 100,
    blocks: [{ type: 'thinking', at: T + 600 }, { type: 'text', at: T + 3000 }],
    usage: { in: 340, cacheW: 9000, cacheR: 128000, out: 1100 },
  },
  { seq: 3, ts: T + 5200, turn: 14, kind: 'tool_result', sinceMs: 1200, bytes: 10, isError: false },
  {
    seq: 4, ts: T + 9000, turn: 14, kind: 'request', startAt: T + 5200,
    blocks: [],
    usage: { in: 90, cacheW: 0, cacheR: 137000, out: 260 },
  },
  { seq: 5, ts: T + 9100, turn: 15, kind: 'user', text: 'next' },
];

test('turns group newest first, entries in arrival order', () => {
  const turns = groupTurns(fixture);
  assert.deepEqual(turns.map(([n]) => n), [15, 14]);
  assert.deepEqual(turns[1][1].map((e: any) => e.seq), [1, 2, 3, 4]);
});

test('anatomy: blocks split a request, gaps stay gaps, tools come from sinceMs', () => {
  const a = anatomySpans(fixture.filter((e) => e.turn === 14));
  assert.ok(a);
  assert.deepEqual(
    a.spans.map((s: any) => [s.kind, s.to - s.from]),
    [
      ['think', 2400], // t+600 → t+3000
      ['write', 1000], // t+3000 → request end t+4000
      ['tool', 1200], // t+5200 minus sinceMs
      ['write', 3800], // blockless request renders whole as writing, startAt → ts
    ]
  );
  assert.equal(a.sums.think, 2400);
  assert.equal(a.sums.write, 4800);
  assert.equal(a.sums.tool, 1200);
  // Total is wall span of the spans, not the sum — the 1.2s gap between the
  // first request ending and its tool result is waiting, owned by nobody.
  assert.equal(a.total, T + 9000 - (T + 600));
});

test('a request with no block data renders whole rather than vanishing', () => {
  const a = anatomySpans([fixture[3]]);
  assert.ok(a);
  assert.deepEqual(a.spans.map((s: any) => s.kind), ['write']);
});

test('no timed content yields null, not an empty strip', () => {
  assert.equal(anatomySpans([fixture[0]]), null);
});

test('token summary: moved is every request end to end, pct is cache reads of that', () => {
  const reqs = fixture.filter((e) => e.kind === 'request');
  const { max, moved, cachedPct } = tokenSummary(reqs);
  assert.equal(max, 138440);
  assert.equal(moved, 138440 + 137350);
  assert.equal(cachedPct, Math.round(((128000 + 137000) / moved) * 100));
});

test('formatting stays terse at panel scale', () => {
  assert.equal(fmtTok(340), '340');
  assert.equal(fmtTok(1100), '1.1k');
  // The decimal drops at 100k — at that magnitude it is noise, not precision.
  assert.equal(fmtTok(138440), '138k');
  assert.equal(fmtTok(411000), '411k');
  assert.equal(fmtMs(480), '480ms');
  assert.equal(fmtMs(35900), '35.9s');
});
