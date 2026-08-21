// The re-read icon's bookkeeping, against fake trees — the wire.js pattern:
// browser code is testable when the hard part is arithmetic. A wrong range or
// a wrong splice never throws; it renders the speaker mid-sentence or hands
// the wrong paragraph to the mouth, and nothing else would ever say so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { paragraphRanges, insertAtOffset } from '../ui/reread.js';

// --- paragraphRanges --------------------------------------------------------

test('one paragraph is one range over its trimmed extent', () => {
  const text = '  hello world\n';
  const [r, ...rest] = paragraphRanges(text);
  assert.equal(rest.length, 0);
  assert.equal(text.slice(r.start, r.end), 'hello world');
});

test('blank-line separation, including separators with spaces in them', () => {
  const text = 'first para.\n\nsecond para.\n   \nthird.';
  const got = paragraphRanges(text).map((r) => text.slice(r.start, r.end));
  assert.deepEqual(got, ['first para.', 'second para.', 'third.']);
});

test('offsets index the ORIGINAL string, not a trimmed copy', () => {
  const text = '\n\nlead\n\ntail\n\n';
  const ranges = paragraphRanges(text);
  assert.deepEqual(
    ranges.map((r) => text.slice(r.start, r.end)),
    ['lead', 'tail']
  );
  // The whole point of positional ranges: they survive being used against the
  // untrimmed string a DOM was built from.
  assert.equal(text.slice(ranges[1].start, ranges[1].end), 'tail');
});

test('whitespace-only text yields no ranges', () => {
  assert.deepEqual(paragraphRanges(''), []);
  assert.deepEqual(paragraphRanges('  \n \n  '), []);
});

test('matches the spoken.ts splitting rule paragraph-for-paragraph', () => {
  const text = 'a\n\nb\nstill b\n\n- list\n- items\n\nlast.';
  const spokenStyle = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const got = paragraphRanges(text).map((r) => text.slice(r.start, r.end));
  assert.deepEqual(got, spokenStyle);
});

// --- insertAtOffset ---------------------------------------------------------
//
// A fake tree with exactly the surface the walker touches: nodeType,
// nodeValue/splitText for text, childNodes/insertBefore/append for elements.

const textNode = (s: string): any => ({
  nodeType: 3,
  nodeValue: s,
  parentNode: null,
  splitText(this: any, at: number) {
    const rest = textNode(this.nodeValue.slice(at));
    this.nodeValue = this.nodeValue.slice(0, at);
    const sib = this.parentNode.childNodes;
    sib.splice(sib.indexOf(this) + 1, 0, rest);
    rest.parentNode = this.parentNode;
    return rest;
  },
});

const elNode = (...children: any[]): any => {
  const n: any = {
    nodeType: 1,
    childNodes: children,
    insertBefore(node: any, ref: any) {
      this.childNodes.splice(this.childNodes.indexOf(ref), 0, node);
      node.parentNode = this;
    },
    append(node: any) {
      this.childNodes.push(node);
      node.parentNode = this;
    },
  };
  for (const c of children) c.parentNode = n;
  return n;
};

const marker = (): any => ({ nodeType: 1, marker: true, childNodes: [] });

/** The tree as a string, markers drawn as ¶ — order is the whole assertion. */
const flat = (n: any): string =>
  n.marker ? '¶' : n.nodeType === 3 ? n.nodeValue : n.childNodes.map(flat).join('');

test('splits a text node when the offset falls inside one', () => {
  const root = elNode(textNode('hello world'));
  insertAtOffset(root, 5, marker());
  assert.equal(flat(root), 'hello¶ world');
});

test('an offset at a node boundary lands after that node', () => {
  const root = elNode(textNode('ab'), textNode('cd'));
  insertAtOffset(root, 2, marker());
  assert.equal(flat(root), 'ab¶cd');
});

test('counts through nested elements — a paragraph ending inside bold', () => {
  const root = elNode(textNode('a '), elNode(textNode('bold')), textNode(' tail'));
  insertAtOffset(root, 6, marker());
  assert.equal(flat(root), 'a bold¶ tail');
});

test('an offset past the end appends rather than vanishing', () => {
  const root = elNode(textNode('abc'));
  insertAtOffset(root, 99, marker());
  assert.equal(flat(root), 'abc¶');
});

test('earlier markers contribute no characters to later insertions', () => {
  // The real caller inserts one button per paragraph, ascending; the second
  // splice must not be shifted by the first. This is the invisible failure the
  // module exists for.
  const text = 'one\n\ntwo';
  const root = elNode(textNode(text));
  for (const r of paragraphRanges(text)) insertAtOffset(root, r.end, marker());
  assert.equal(flat(root), 'one¶\n\ntwo¶');
});
