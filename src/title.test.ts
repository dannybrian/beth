// The tab title, in node — a badge nobody is looking at when it is wrong.
//
// Both failures are silent. A summons that never appears leaves a session
// stopped at a card with no tell but silence, which is the hang this glyph
// exists to end; one that sticks after the answer is a tab crying wolf, and a
// tab that cries wolf stops being read — taking the real ones with it.
import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — browser module, plain JS on purpose
import { tabTitle } from '../ui/title.js';

const state = (over: Record<string, unknown> = {}) => ({
  base: 'beth',
  blocked: false,
  decisions: 0,
  error: false,
  running: false,
  ...over,
});

test('a quiet tab is just the name', () => {
  assert.equal(tabTitle(state()), 'beth');
  assert.equal(tabTitle(state({ testLight: 'green' })), 'beth 🟢');
  // Grey says nothing rather than ⚪ — see title.js.
  assert.equal(tabTitle(state({ testLight: 'grey' })), 'beth');
  assert.equal(tabTitle(state({ testLight: undefined })), 'beth');
});

test('what is waiting on you is front-loaded, most-blocking first', () => {
  assert.equal(tabTitle(state({ running: true })), '● beth');
  assert.equal(tabTitle(state({ decisions: 3 })), '(3) beth');
  assert.equal(tabTitle(state({ decisions: 3, running: true })), '(3) ● beth');
  // Stopped outranks queued, and stays ahead of it where truncation cannot reach.
  assert.equal(tabTitle(state({ blocked: true, decisions: 3 })), '❗ (3) beth');
});

test('a card she is stopped on is NOT counted as a queued decision', () => {
  // The whole point of the split: the queue is ignorable by design, being
  // stopped is not. Folding the card into (N) would say "one thing to read
  // sometime" about a halted session.
  assert.equal(tabTitle(state({ blocked: true })), '❗ beth');
  assert.notEqual(tabTitle(state({ blocked: true })), tabTitle(state({ decisions: 1 })));
});

test('blocked suppresses the running dot but never the error', () => {
  // She is not thinking, she is waiting on you — two glyphs for one state is
  // noise in the few characters a tab gets.
  assert.equal(tabTitle(state({ blocked: true, running: true })), '❗ beth');
  // An error is a different thing going wrong, and outranks the dot as before.
  assert.equal(tabTitle(state({ error: true, running: true })), '⚠ beth');
  assert.equal(tabTitle(state({ blocked: true, error: true })), '❗ ⚠ beth');
});

test('the tree state goes AFTER the name — a status, not a summons', () => {
  assert.equal(
    tabTitle(state({ blocked: true, decisions: 2, testLight: 'red', base: 'beth · beadgame' })),
    '❗ (2) beth · beadgame 🔴',
  );
});
