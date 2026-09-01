// The plan reader's parse, in node.
//
// Its failures are silent by nature: a mis-parse renders confident, well-formed,
// WRONG markup — a checklist that loses its checkboxes, a table read as prose, a
// fenced block whose contents escape and become headings. Nothing throws. The
// construct list here is measured from 40 of beadgame's unity plans rather than
// from a spec, because that is what this actually has to read.
import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — browser module, plain JS on purpose
import { parseBlocks, parseInline } from '../ui/md.js';

const kinds = (blocks: any[]) => blocks.map((b) => b.t);

test('frontmatter is kept, not silently dropped', () => {
  // status/priority/depends_on live here; hiding them would make the preview a
  // worse view of the plan than `cat`.
  const b = parseBlocks('---\nstatus: parked\npriority: P1\n---\n\n# Title\n');
  assert.equal(b[0].t, 'frontmatter');
  assert.match(b[0].v, /status: parked/);
  assert.equal(b[1].t, 'heading');
  // A bare --- later in the body is a rule, not a second frontmatter block.
  assert.deepEqual(kinds(parseBlocks('# a\n\n---\n\n# b')), ['heading', 'hr', 'heading']);
});

test('inline: code wins over emphasis', () => {
  // Plans are full of shell and regex; `**` inside backticks is a literal.
  assert.deepEqual(parseInline('`**not bold**`'), [{ t: 'code', v: '**not bold**' }]);
  const [, link] = parseInline('see [the brief](2026-07-27-166-x.md) now');
  assert.equal(link.t, 'link');
  assert.equal(link.href, '2026-07-27-166-x.md');
});

test('checkboxes survive as state, not as text', () => {
  // 396 of them in the sample. A checklist that renders "[x]" as prose is the
  // single most useful thing in a plan turned into the least readable.
  const [list] = parseBlocks('- [x] done thing\n- [ ] pending thing\n- plain bullet');
  assert.equal(list.t, 'list');
  assert.equal(list.items[0].done, true);
  assert.equal(list.items[1].done, false);
  assert.equal(list.items[2].done, undefined, 'a plain bullet is not a checkbox');
});

test('nested lists nest', () => {
  const [list] = parseBlocks('- top\n  - under\n  - also under\n- second');
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0].blocks[0].t, 'list');
  assert.equal(list.items[0].blocks[0].items.length, 2);
});

test('ordered lists keep their kind', () => {
  assert.equal(parseBlocks('1. one\n2. two')[0].ordered, true);
  assert.equal(parseBlocks('- one')[0].ordered, false);
});

test('a longer fence survives a shorter one inside it', () => {
  // Plans quote markdown, so this is not hypothetical.
  const [code] = parseBlocks('````\n```js\nx\n```\n````\n');
  assert.equal(code.t, 'code');
  assert.equal(code.v, '```js\nx\n```');
  assert.equal(code.unclosed, false);
});

test('an unclosed fence swallows the rest instead of leaking headings', () => {
  const [code] = parseBlocks('```\nnot # a heading\n');
  assert.equal(code.t, 'code');
  assert.equal(code.unclosed, true, 'flagged, so the view can say so');
});

test('a table needs its separator — a pipe in prose is prose', () => {
  const [tbl] = parseBlocks('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.equal(tbl.t, 'table');
  assert.equal(tbl.head.length, 2);
  assert.equal(tbl.rows.length, 1);
  assert.deepEqual(kinds(parseBlocks('use a | b for that')), ['para']);
});

test('quotes hold blocks, not a flat string', () => {
  const [q] = parseBlocks('> ## inside\n> and text');
  assert.equal(q.t, 'quote');
  assert.deepEqual(kinds(q.blocks), ['heading', 'para']);
});

test('a real plan opening parses to the right shape', () => {
  const b = parseBlocks(
    [
      '---', 'status: parked', 'tags: [unity, ui]', '---', '',
      '# Menu Fluidity + Screen Revival', '',
      '> Planned 2026-07-30 from brief `2026-07-27-166-x.md`, with', '> direction calls made.', '',
      '## SUPERSEDED — 2026-08-06', '',
      "**Danny's call: superseded by `176`.**", '',
      '- [x] OQ1 answered', '- [ ] OQ3 open',
    ].join('\n')
  );
  assert.deepEqual(kinds(b), ['frontmatter', 'heading', 'quote', 'heading', 'para', 'list']);
  assert.equal(b[5].items[0].done, true);
});

test('a wrapped bullet stays IN its bullet', () => {
  // The bug the screenshot caught: the tail of a long bullet broke out of the
  // list and rendered as an unindented paragraph. All the text was there, so it
  // read as a formatting quirk rather than a parse failure.
  const [list, ...rest] = parseBlocks(
    ['- **BookPresenter** (`x.cs`) — the MonoBehaviour that owns',
     '  the book’s world presence: where it sits.',
     '- second bullet'].join('\n')
  );
  assert.equal(list.t, 'list');
  assert.equal(rest.length, 0, 'the continuation must not become a sibling block');
  assert.equal(list.items.length, 2);
  const flat = JSON.stringify(list.items[0].c);
  assert.match(flat, /world presence/);
});

test('a blank line then unindented prose ENDS the list', () => {
  const b = parseBlocks('- one\n- two\n\nA new paragraph entirely.');
  assert.deepEqual(kinds(b), ['list', 'para']);
  assert.equal(b[0].items.length, 2);
});

test('a wrapped checkbox keeps its state', () => {
  const [list] = parseBlocks('- [x] the thing that was done\n  and its trailing clause');
  assert.equal(list.items[0].done, true);
  assert.match(JSON.stringify(list.items[0].c), /trailing clause/);
});

test('nesting survives the continuation rule', () => {
  const [list] = parseBlocks('- top bullet\n  wrapped on\n  - under one\n  - under two\n- next');
  assert.equal(list.items.length, 2);
  assert.match(JSON.stringify(list.items[0].c), /wrapped on/);
  assert.equal(list.items[0].blocks[0].t, 'list');
  assert.equal(list.items[0].blocks[0].items.length, 2);
});
