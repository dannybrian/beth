import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderInline, stripMarkdown } from './markdown.ts';

/** The span kinds covering `needle`, for readable assertions. */
const kindsOver = (src: string, needle: string) => {
  const { text, spans } = renderInline(src);
  const at = text.indexOf(needle);
  assert.notEqual(at, -1, `${JSON.stringify(needle)} not in ${JSON.stringify(text)}`);
  return spans
    .filter((s) => s.start <= at && s.end >= at + needle.length)
    .map((s) => s.kind)
    .sort();
};

test('markers come off and the span lands on the right characters', () => {
  const { text, spans } = renderInline('The cheapest win is **viz geography** today.');
  assert.equal(text, 'The cheapest win is viz geography today.');
  assert.deepEqual(spans, [{ start: 20, end: 33, kind: 'bold' }]);
  assert.equal(text.slice(20, 33), 'viz geography');
});

test('every inline form is recognised', () => {
  assert.deepEqual(kindsOver('shipped as `407e186f` today', '407e186f'), ['code']);
  assert.deepEqual(kindsOver('that is *not* the plan', 'not'), ['italic']);
  assert.deepEqual(kindsOver('__really__ done', 'really'), ['bold']);
  assert.deepEqual(kindsOver('~~blocked~~ now free', 'blocked'), ['strike']);
  assert.deepEqual(kindsOver('# Prod residue', 'Prod residue'), ['heading']);
});

test('emphasis nests', () => {
  assert.deepEqual(kindsOver('**see `build-gazetteer.js` first**', 'build-gazetteer.js'), ['bold', 'code']);
  assert.deepEqual(kindsOver('**bold and *also* italic**', 'also'), ['bold', 'italic']);
});

// The failure mode that makes a naive stripper worse than none: identifiers and
// arithmetic are not emphasis, and mangling them corrupts what she actually said.
test('word-internal markers are left alone', () => {
  for (const s of ['scripts/lexicon/build_gazetteer_v2.js', 'roughly 2*3*4 rows', 'a__b__c']) {
    assert.equal(stripMarkdown(s), s);
  }
});

test('a lone or unclosed marker is literal', () => {
  for (const s of ['3 * 4 is twelve', 'the ** in her prose', 'half of `a code span']) {
    assert.equal(stripMarkdown(s), s);
  }
});

test('backslash escapes yield the character and no formatting', () => {
  const { text, spans } = renderInline('a literal \\*star\\* here');
  assert.equal(text, 'a literal *star* here');
  assert.deepEqual(spans, []);
});

test('bullets keep their shape without keeping their marker', () => {
  const { text } = renderInline('- first\n- second');
  assert.equal(text, '• first\n• second');
});

test('spans survive multiple lines with the right offsets', () => {
  const { text, spans } = renderInline('one **two**\nthree **four**');
  assert.equal(text, 'one two\nthree four');
  assert.deepEqual(
    spans.map((s) => text.slice(s.start, s.end)),
    ['two', 'four']
  );
});

test('plain prose is returned untouched', () => {
  const s = "Seventy plans in flight, so the useful question isn't what we could do.";
  const { text, spans } = renderInline(s);
  assert.equal(text, s);
  assert.deepEqual(spans, []);
});

// Voice is why this exists at all — TTS reading asterisks aloud is the bug.
test('the spoken form carries no markers', () => {
  assert.equal(stripMarkdown('**Shipped.** See `plans/INDEX.md`.'), 'Shipped. See plans/INDEX.md.');
});

test('audio tags pass straight through — they are the voice layer, not markdown', () => {
  assert.equal(stripMarkdown('[laughs] **got it**'), '[laughs] got it');
});

// --- tables ------------------------------------------------------------------

const TABLE = [
  'Figures first.',
  '',
  '| Model | Offline? | Size |',
  '|---|---|---|',
  '| **Opus** | No. Cloud only | n/a |',
  '| Gemma 3 | Yes | ~8 GB |',
  '',
  'The pattern: small ones fit.',
].join('\n');

test('a table becomes tab-and-newline text, with the separator row gone', () => {
  const { text } = renderInline(TABLE);
  assert.equal(
    text,
    'Figures first.\n\nModel\tOffline?\tSize\nOpus\tNo. Cloud only\tn/a\nGemma 3\tYes\t~8 GB\n\nThe pattern: small ones fit.'
  );
});

test('table, rows and cells TILE the text — every character in exactly one cell', () => {
  const { text, spans } = renderInline(TABLE);
  const [table] = spans.filter((s) => s.kind === 'table');
  const rows = spans.filter((s) => s.kind === 'row');
  const cells = spans.filter((s) => s.kind === 'th' || s.kind === 'td');
  assert.equal(rows.length, 3);
  assert.equal(cells.length, 9);
  assert.deepEqual(cells.slice(0, 4).map((c) => c.kind), ['th', 'th', 'th', 'td']);
  // Contiguous: the page builds its DOM from these and reread.js counts text
  // characters through it, so a gap or an overlap lands the speaker mid-word.
  for (const set of [rows, cells]) {
    assert.equal(set[0].start, table.start);
    assert.equal(set.at(-1)!.end, table.end);
    for (let i = 1; i < set.length; i++) assert.equal(set[i].start, set[i - 1].end);
  }
  assert.equal(text.slice(cells[4].start, cells[4].end), 'No. Cloud only\t');
  // The table owns the newline that ends it, and not the blank line after.
  assert.equal(text.slice(table.end), '\nThe pattern: small ones fit.');
});

test('formatting inside a cell is a span inside that cell', () => {
  assert.deepEqual(kindsOver(TABLE, 'Opus'), ['bold', 'row', 'table', 'td']);
});

test('an empty cell keeps its width; an escaped pipe is a pipe', () => {
  const { text, spans } = renderInline('| a | b |\n|---|---|\n|  | x \\| y |');
  assert.equal(text, 'a\tb\n\tx | y');
  const cells = spans.filter((s) => s.kind === 'td');
  assert.deepEqual(cells.map((c) => text.slice(c.start, c.end)), ['\t', 'x | y']);
});

test('a table that ends the message with an empty cell emits no zero-width span', () => {
  const { spans } = renderInline('| a | b |\n|---|---|\n| x |  |');
  assert.ok(spans.every((s) => s.end > s.start));
});

test('a pipe in prose is not a table, and neither is one inside a fence', () => {
  const prose = 'run `a | b` and see\nwhat comes back';
  assert.equal(renderInline(prose).spans.some((s) => s.kind === 'table'), false);
  const fenced = '```\n| a | b |\n|---|---|\n| 1 | 2 |\n```';
  const r = renderInline(fenced);
  assert.equal(r.spans.some((s) => s.kind === 'table'), false);
  assert.equal(r.text, fenced);
});

test('a bullet list under a line with a pipe is not a table', () => {
  // `- item` would satisfy a careless separator pattern.
  const r = renderInline('a | b\n- item');
  assert.equal(r.spans.some((s) => s.kind === 'table'), false);
});

test('a rule under a line with a pipe is not a table — the columns must agree', () => {
  assert.equal(renderInline('a | b\n---').spans.some((s) => s.kind === 'table'), false);
});
