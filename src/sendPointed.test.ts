// What Danny SAID, against what Beth was told.
//
// `send()` splits the two on purpose — the transcript shows his sentence, the
// model gets it wrapped in whatever scaffolding the turn needs. Every scaffold
// added since has to go on the model's copy only, and the failure is invisible
// from this side of the code: the wrong split does not throw, it puts a note
// addressed to Beth into the transcript as a line Danny appears to have typed.
// He saw one (`[harness: You have nothing on file about how he is doing…]`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Suggestion } from './suggestion.ts';
import { ConversationBus, type UIMessage } from './bus.ts';
import { SessionManager } from './session.ts';
import type { HarnessConfig } from './config.ts';
import type { WorkRef } from './workItems.ts';

/**
 * A session with no SDK behind it. `send()` only publishes and pushes to the
 * input stream, so everything under test runs without a query — which is the
 * only reason this file can exist at all.
 */
function harness(opts: { beat?: string | null; refs?: WorkRef[]; preamble?: string; items?: Record<string, any> } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-send-'));
  const cfg = { stateDir, repo: stateDir, directorPlan: 'x.md', personal: true } as HarnessConfig;
  const bus = new ConversationBus();
  const seen: UIMessage[] = [];
  bus.subscribe((m) => seen.push(m));
  const s = new SessionManager(cfg, bus, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, new Suggestion());
  const sent: string[] = [];
  // The model's copy, taken where it enters the SDK rather than where it is built.
  (s as any).input = { push: (m: any) => sent.push(m.message.content), end() {} };
  (s as any).work = {
    takePointed: () => opts.refs ?? [],
    preamble: () => opts.preamble ?? '',
    byPath: (p: string) => opts.items?.[p],
  };
  s.personal.beat = () => opts.beat ?? null;
  // Long enough ago to count as arriving, which is the only time a beat rides along.
  (s as any).lastHumanTurnAt = 1;
  const shown = () => (seen.find((m) => m.type === 'user') as any)?.text;
  return { s, sent, shown };
}

test('the personal beat reaches Beth and never the transcript', () => {
  const { s, sent, shown } = harness({ beat: 'Ask whether the move went through.' });
  s.sendPointed('where are we on the panel?');
  assert.match(sent[0], /\[harness: Ask whether the move went through\.\]/);
  assert.equal(shown(), 'where are we on the panel?');
});

test('the pointing preamble stays off the transcript too', () => {
  const refs = [{ kind: 'plan', path: 'plans/p.md', spoken: 'the panel plan' }] as WorkRef[];
  const { s, sent, shown } = harness({ refs, preamble: '[pointing at "the panel plan"]' });
  s.sendPointed('and this?');
  assert.match(sent[0], /^\[pointing at "the panel plan"\]\n/);
  assert.equal(shown(), 'and this?');
});

test('a turn that is PURE gesture still says so, beat or no beat', () => {
  // The regression the same line caused: an empty sentence with a beat glued to
  // it is truthy, so the "(pointing at …)" fallback could never fire and the
  // transcript showed the harness note as the whole of his turn.
  const refs = [{ kind: 'plan', path: 'plans/p.md', spoken: 'the panel plan' }] as WorkRef[];
  const { s, shown } = harness({ refs, beat: 'Ask about the move.' });
  s.sendPointed('');
  assert.equal(shown(), '(pointing at "the panel plan")');
});

test('with nothing to say about him, nothing is added at all', () => {
  const { s, sent, shown } = harness({ beat: null });
  s.sendPointed('carry on');
  assert.equal(sent[0], 'carry on');
  assert.equal(shown(), 'carry on');
});

// --- a hand-off that arrived is told on his NEXT turn, to her only ----------------

test('an arrival rides the next turn as scaffolding, once, and never the transcript', () => {
  const items = {
    'inbox/memobase/m1': { path: 'inbox/memobase/m1', spoken: 'the settle window', inbox: { from: 'memobase' } },
  };
  const { s, sent, shown } = harness({ beat: null, items });
  s.noteArrival('inbox/memobase/m1');
  s.noteArrival('inbox/memobase/m1');
  s.sendPointed('morning');
  assert.match(sent[0], /^\[harness: since your last turn, 1 hand-off arrived in the inbox:\n- "the settle window" from memobase \(inbox\/memobase\/m1\)\n/);
  assert.match(sent[0], /\]\nmorning$/);
  assert.equal(shown(), 'morning');
  // Drained: the second turn carries nothing.
  s.sendPointed('and?');
  assert.equal(sent[1], 'and?');
});

test('an arrival he already closed before his next turn is not announced', () => {
  const items = {
    'inbox/memobase/m1': { path: 'inbox/memobase/m1', spoken: 'x', inbox: { from: 'memobase', ack: { state: 'dismissed' } } },
  };
  const { s, sent } = harness({ beat: null, items });
  s.noteArrival('inbox/memobase/m1');
  s.noteArrival('inbox/memobase/gone');
  s.sendPointed('hi');
  assert.equal(sent[0], 'hi');
});
