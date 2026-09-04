// The `show` replay split. A pop that replayed would re-open the lightbox on
// every reconnect — the visual version of the bug that keeps `speak` out of
// history — and it would look exactly like the feature working until the first
// mid-conversation reload.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationBus } from './bus.ts';

test('a shown image replays as a figure, with the pop stripped', () => {
  const bus = new ConversationBus();
  bus.publish({ type: 'show', image: { path: 'docs/diagram.png', caption: 'the seam' }, pop: true });
  const replayed = bus.replay().filter((m) => m.type === 'show');
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].image?.path, 'docs/diagram.png');
  assert.equal(replayed[0].pop, undefined);
});

test('a surface show is all pop — none of it reaches history', () => {
  const bus = new ConversationBus();
  bus.publish({ type: 'show', surface: 'pending', pop: true });
  assert.equal(bus.replay().length, 0);
});

// A suggestion is current state, sent fresh on connect — replaying an old one
// after a newer null would resurrect a ghost reply the server already dropped.
test('a suggestion never reaches the replay', () => {
  const bus = new ConversationBus();
  bus.publish({ type: 'suggestion', text: 'Yes, go ahead.' });
  bus.publish({ type: 'suggestion', text: null });
  assert.equal(bus.replay().length, 0);
});

test('live subscribers still see the pop the replay drops', () => {
  const bus = new ConversationBus();
  const seen = [];
  bus.subscribe((m) => seen.push(m));
  bus.publish({ type: 'show', image: { path: 'docs/diagram.png' }, pop: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].pop, true);
});
