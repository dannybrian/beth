// The tap's failures are invisible by construction: a preview that isn't
// truncated is unbounded memory growth nobody sees until the process bloats; a
// wrong `since` cursor is a panel that silently double-renders or misses
// entries; our own turns echoing back as SDKUserMessageReplay would double
// every user line. Bookkeeping, so it is testable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WireTap } from './wireTap.ts';

/** A controllable clock, so timing fields are asserted rather than admired. */
function tap() {
  let t = 1000;
  const w = new WireTap(() => t);
  return { w, tick: (ms: number) => (t += ms) };
}

const assistant = (over: any = {}) => ({
  type: 'assistant',
  message: {
    id: 'msg_1',
    model: 'claude-opus-5',
    usage: { input_tokens: 340, cache_creation_input_tokens: 9000, cache_read_input_tokens: 128000, output_tokens: 1100 },
    content: [
      { type: 'thinking', thinking: 'The failing selector is in app.css.' },
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/x/app.css' } },
    ],
    ...over,
  },
});

test('a full cycle lands as user → request → tool_result → result, in order', () => {
  const { w, tick } = tap();
  w.userTurn(3, 'ship the panel fix');
  tick(400);
  w.record(assistant());
  tick(2000);
  w.record({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'body { }' }] },
  });
  w.record({ type: 'result', duration_ms: 4100, duration_api_ms: 900, num_turns: 2, total_cost_usd: 0.03, usage: {} });

  const kinds = w.read().entries.map((e) => e.kind);
  assert.deepEqual(kinds, ['user', 'request', 'tool_result', 'result']);
  const req = w.read().entries[1] as any;
  assert.equal(req.usage.cacheR, 128000);
  assert.equal(req.thinking[0], 'The failing selector is in app.css.');
  assert.equal(req.tools[0].name, 'Read');
  assert.equal(req.turn, 3, 'everything in the cycle carries the turn it belongs to');
  const tool = w.read().entries[2] as any;
  assert.equal(tool.sinceMs, 2000, 'tool duration is measured from the request completing');
});

test('previews truncate at capture and remember the real size', () => {
  const { w } = tap();
  w.userTurn(1, 'x');
  w.record({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'y'.repeat(50_000) }] },
  });
  const tool = w.read().entries[1] as any;
  assert.equal(tool.bytes, 50_000);
  assert.ok(tool.preview.length < 500, 'the buffer holds a preview, never the payload');
});

test('our own turn echoing back as a replay is not recorded twice', () => {
  const { w } = tap();
  w.userTurn(1, 'hello');
  // The SDK replays pushed turns as user messages with STRING content.
  w.record({ type: 'user', message: { role: 'user', content: 'hello' } });
  assert.equal(w.read().entries.length, 1);
});

test('stream events yield block boundaries and ttft, never entries of their own', () => {
  const { w, tick } = tap();
  w.userTurn(1, 'go');
  w.record({ type: 'stream_event', ttft_ms: 480, event: { type: 'message_start' } });
  w.record({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } });
  tick(1200);
  w.record({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
  w.record({ type: 'stream_event', event: { type: 'content_block_delta' } }); // the flood — ignored
  w.record(assistant());
  const entries = w.read().entries;
  assert.equal(entries.length, 2, 'stream events are folded into the request, not stored');
  const req = entries[1] as any;
  assert.equal(req.ttftMs, 480);
  assert.deepEqual(req.blocks.map((b: any) => b.type), ['thinking', 'text']);
  assert.equal(req.blocks[1].at - req.blocks[0].at, 1200);
});

test('the ring caps, dropping oldest first', () => {
  const { w } = tap();
  for (let i = 0; i < 1000; i++) w.userTurn(i, `t${i}`);
  const entries = w.read().entries;
  assert.equal(entries.length, 800);
  assert.equal((entries[0] as any).text, 't200', 'oldest fell off');
});

test('since-cursor returns only what the panel has not seen', () => {
  const { w } = tap();
  w.userTurn(1, 'a');
  const { seq } = w.read();
  w.userTurn(2, 'b');
  const delta = w.read(seq);
  assert.equal(delta.entries.length, 1);
  assert.equal((delta.entries[0] as any).text, 'b');
  assert.equal(w.read(delta.seq).entries.length, 0, 'a caught-up poll is empty');
});

test('a compaction is an event; init noise is not', () => {
  const { w } = tap();
  w.record({ type: 'system', subtype: 'init', session_id: 's' });
  w.record({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } });
  const entries = w.read().entries;
  assert.equal(entries.length, 1);
  assert.match((entries[0] as any).detail, /150000 tokens before/);
});
