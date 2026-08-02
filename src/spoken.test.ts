import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spokenFor, lastParagraph, lastSentence } from './spoken.ts';

const reply = (text: string) => ({ type: 'assistant' as const, text });
const say = (kind: string, text: string) => ({ type: 'say' as const, kind, text });

// The shape that started this: real code work, six paragraphs on the page, and
// ninety seconds of unskippable audio if every word is read out.
const LONG = [
  "Here's the real state, and it's better than the board says.",
  'The gazetteer builder landed on July sixteenth, in the same pair of commits as the pin resolution.',
  'The two open checkboxes were stale bookkeeping — nothing was left to do.',
  "So it's shipped and off the board. Nothing on that plan ever touched production.",
].join('\n\n');

test('a long reply is heard as its last paragraph only', () => {
  assert.equal(
    spokenFor(reply(LONG), 'brief'),
    "So it's shipped and off the board. Nothing on that plan ever touched production."
  );
});

test('a one-line progress note is its own last paragraph, so it survives intact', () => {
  const line = 'Let me read it and see what those last two tasks actually are.';
  for (const level of ['full', 'brief', 'headlines'] as const) {
    assert.equal(spokenFor(reply(line), level), line, `should survive at ${level}`);
  }
});

test('a trailing checklist is not what gets read out', () => {
  const text = 'Two things are left before this ships.\n\n- wire the reader\n- write the test';
  assert.equal(lastParagraph(text), 'Two things are left before this ships.');
});

test('full speaks everything, exactly as before', () => {
  assert.equal(spokenFor(reply(LONG), 'full'), LONG);
  assert.equal(spokenFor(say('status', 'Running the suites.'), 'full'), 'Running the suites.');
});

// `say` is one item per call with a first sentence that stands alone — the shape
// the excerpt rule would otherwise have to impose.
test('say items are never excerpted', () => {
  const long = say('event', LONG);
  assert.equal(spokenFor(long, 'brief'), LONG);
});

test('headlines keeps results and drops the chatter', () => {
  assert.equal(spokenFor(say('finding', 'The builder used the 110m file, not the 10m.'), 'headlines'), 'The builder used the 110m file, not the 10m.');
  assert.equal(spokenFor(say('event', 'Viz geography is shipped.'), 'headlines'), 'Viz geography is shipped.');
  assert.equal(spokenFor(say('status', 'Reading the runbook.'), 'headlines'), '');
  assert.equal(spokenFor(reply(LONG), 'headlines'), '', 'a long reply is read on the page, not aloud');
});

test('an empty or whitespace message is never spoken', () => {
  assert.equal(spokenFor(reply('   '), 'brief'), '');
  assert.equal(spokenFor(reply(''), 'full'), '');
});

test('the last sentence is the fallback when a level would leave silence', () => {
  assert.equal(lastSentence(LONG), 'Nothing on that plan ever touched production.');
  assert.equal(lastSentence('no punctuation here'), 'no punctuation here');
});

test('off speaks nothing at all — the page carries every word', () => {
  assert.equal(spokenFor(reply(LONG), 'off'), '');
  assert.equal(spokenFor(reply('Let me check that.'), 'off'), '');
  for (const kind of ['status', 'finding', 'event', 'answer']) {
    assert.equal(spokenFor(say(kind, 'shipped'), 'off'), '', `${kind} is silent too`);
  }
});
