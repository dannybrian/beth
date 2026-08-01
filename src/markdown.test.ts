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
