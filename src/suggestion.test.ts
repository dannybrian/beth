// The ghost reply's lifecycle. Every mistake here is invisible on the page:
// a suggestion shown mid-turn looks like a fast one, a stale one under a new
// answer looks like a confident one, and one that survives an interrupt
// looks like she is pressing the point.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Suggestion, vetSuggestion, bootSuggestion, SUGGESTION_MAX } from './suggestion.ts';

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

// A fixed hour, so the tests pin the line rather than the clock they ran at.
const MORNING = new Date(2026, 8, 4, 9, 0, 0);
const OPENING = 'Hey, Wren, good morning! Bring me up to speed.';

// The boot seed. The failure here is silent in both directions: a seed that
// does not survive the greeting turn's start leaves an empty composer on a page
// that just opened, and one that survives too long puts "bring me up to speed"
// under a sentence Danny has already typed.
test('the boot seed rides out the greeting turn and lands when it ends', () => {
  const s = new Suggestion();
  s.seed(bootSuggestion('Wren', MORNING));
  // Nothing yet: the greeting has not been written.
  assert.equal(s.current(), null);
  assert.equal(s.turnStarted(), null);
  assert.equal(s.current(), null);
  assert.deepEqual(s.turnEnded(true), { type: 'suggestion', text: OPENING });
});

test('the boot seed is spent by that one turn, never a later one', () => {
  const s = new Suggestion();
  s.seed(bootSuggestion('Wren', MORNING));
  s.turnStarted();
  s.turnEnded(true);
  // His reply drops it like any other shown suggestion...
  assert.deepEqual(s.turnStarted(), { type: 'suggestion', text: null });
  // ...and it does not come back at the end of the turn he just began.
  assert.equal(s.turnEnded(true), null);
});

test('an interrupted greeting shows no opening line', () => {
  const s = new Suggestion();
  s.seed(bootSuggestion('Wren', MORNING));
  s.turnStarted();
  assert.equal(s.turnEnded(false), null);
  assert.equal(s.current(), null);
});

test('her own offer in the greeting turn beats the seed', () => {
  const s = new Suggestion();
  s.seed(bootSuggestion('Wren', MORNING));
  s.turnStarted();
  s.offer('Yes, pick that back up.');
  assert.equal(s.turnEnded(true)?.text, 'Yes, pick that back up.');
});

test('a clear leaves no greeting for the seed to answer', () => {
  const s = new Suggestion();
  s.seed(bootSuggestion('Wren', MORNING));
  assert.equal(s.reset(), null);
  s.turnStarted();
  assert.equal(s.turnEnded(true), null);
});

// The other new conversation: a `/clear`, where nothing is in flight and no
// greeting is coming, so the same line goes straight into the box.
test('a cleared conversation shows the opening line at once', () => {
  const s = new Suggestion();
  s.offer('Yes, go ahead.');
  s.turnEnded(true);
  assert.deepEqual(s.reset(), { type: 'suggestion', text: null });
  assert.deepEqual(s.show(bootSuggestion('Wren', MORNING)), {
    type: 'suggestion',
    text: OPENING,
  });
  assert.equal(s.current(), OPENING);
});

test('showing the same line again publishes nothing', () => {
  const s = new Suggestion();
  s.show(bootSuggestion('Wren', MORNING));
  assert.equal(s.show(bootSuggestion('Wren', MORNING)), null);
  // And a refused line leaves what is showing alone.
  assert.equal(s.show('x'.repeat(SUGGESTION_MAX + 1)), null);
  assert.equal(s.current(), OPENING);
});

test('a shown opening line goes the moment he says anything', () => {
  const s = new Suggestion();
  s.show(bootSuggestion('Wren', MORNING));
  assert.deepEqual(s.turnStarted(), { type: 'suggestion', text: null });
  assert.equal(s.turnEnded(true), null);
});

test('the opening line fits the composer', () => {
  assert.equal(vetSuggestion(bootSuggestion('Wren', MORNING)).ok, true);
  // A persona with a long name is still one line.
  assert.equal(vetSuggestion(bootSuggestion('W'.repeat(40))).ok, true);
});

// The one part that moves. A "good morning" in the box at four in the
// afternoon is a line he has to edit before sending, which is worse than an
// empty box — and the harness runs for days, so the hour has to be read when
// the line is built rather than when the process started.
test('the opening line greets the hour it is built in', () => {
  const at = (h: number) => bootSuggestion('Wren', new Date(2026, 8, 4, h, 30));
  assert.equal(at(9), OPENING);
  assert.match(at(16), /good afternoon!/);
  assert.match(at(21), /good evening!/);
  // Boundaries, and the small hours, which belong to the evening.
  assert.match(at(5), /good morning!/);
  assert.match(at(11), /good morning!/);
  assert.match(at(12), /good afternoon!/);
  assert.match(at(17), /good afternoon!/);
  assert.match(at(18), /good evening!/);
  assert.match(at(1), /good evening!/);
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
