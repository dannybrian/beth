// The ghost reply's lifecycle. Every mistake here is invisible on the page:
// a suggestion shown mid-turn looks like a fast one, a stale one under a new
// answer looks like a confident one, and one that survives an interrupt
// looks like she is pressing the point.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Suggestion, vetSuggestion, SUGGESTION_MAX } from './suggestion.ts';

test('an offer is held, not shown, until the turn ends cleanly', () => {
  const s = new Suggestion();
  assert.deepEqual(s.offer('Yes, go ahead.'), { ok: true, text: 'Yes, go ahead.' });
  assert.equal(s.current(), null);
  assert.deepEqual(s.turnEnded(true), { type: 'suggestion', text: 'Yes, go ahead.' });
  assert.equal(s.current(), 'Yes, go ahead.');
  assert.deepEqual(s.message(), { type: 'suggestion', text: 'Yes, go ahead.' });
});

test('a turn that did not end cleanly shows nothing, and the offer is gone', () => {
  const s = new Suggestion();
  s.offer('Commit it.');
  assert.equal(s.turnEnded(false), null);
  assert.equal(s.current(), null);
  // The next clean end has nothing left over from the interrupted turn.
  assert.equal(s.turnEnded(true), null);
});

test('a new turn drops what was showing, and says so once', () => {
  const s = new Suggestion();
  s.offer('Run the tests.');
  s.turnEnded(true);
  assert.deepEqual(s.turnStarted(), { type: 'suggestion', text: null });
  assert.equal(s.current(), null);
  // Already empty: nothing to publish, so a quiet turn costs the bus nothing.
  assert.equal(s.turnStarted(), null);
});

test('a new turn drops what was held too — it belonged to the turn before', () => {
  const s = new Suggestion();
  s.offer('Go ahead.');
  s.turnStarted();
  assert.equal(s.turnEnded(true), null);
});

test('a second offer in one turn replaces the first', () => {
  const s = new Suggestion();
  s.offer('Ship it.');
  s.offer('Ship it, then tag the release.');
  assert.equal(s.turnEnded(true)?.text, 'Ship it, then tag the release.');
});

test('a clean end with nothing held changes nothing', () => {
  const s = new Suggestion();
  s.offer('Yes.');
  s.turnEnded(true);
  // The shown one stands across a turn end that offered nothing new.
  assert.equal(s.turnEnded(true), null);
  assert.equal(s.current(), 'Yes.');
});

test('reset clears like a new turn', () => {
  const s = new Suggestion();
  s.offer('Yes.');
  s.turnEnded(true);
  assert.deepEqual(s.reset(), { type: 'suggestion', text: null });
  assert.equal(s.reset(), null);
});

test('vetting: one line, trimmed, collapsed', () => {
  assert.deepEqual(vetSuggestion('  Yes,\n  go ahead.  '), { ok: true, text: 'Yes, go ahead.' });
});

test('vetting refuses empty, non-string and paragraph-length text with a reason', () => {
  assert.equal(vetSuggestion('   \n ').ok, false);
  assert.equal(vetSuggestion(undefined).ok, false);
  const long = vetSuggestion('x'.repeat(SUGGESTION_MAX + 1));
  assert.equal(long.ok, false);
  assert.match((long as { reason: string }).reason, /too long/);
  // A refused offer leaves nothing held.
  const s = new Suggestion();
  s.offer('x'.repeat(SUGGESTION_MAX + 1));
  assert.equal(s.turnEnded(true), null);
});
