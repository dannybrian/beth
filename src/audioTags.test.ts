import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripAudioTags, hasAudioTags, forVoice, isMeaningfulUtterance } from './audioTags.ts';

test('strips a tag and repairs the spacing around it', () => {
  assert.equal(stripAudioTags('[laughs] That one was my fault.'), 'That one was my fault.');
  assert.equal(stripAudioTags('Third flaky test today [sighs].'), 'Third flaky test today.');
  assert.equal(stripAudioTags('Shipped it [laughs] finally.'), 'Shipped it finally.');
});

test('leaves ordinary bracketed prose alone', () => {
  const s = 'See [plan 175] and the [WIP] branch.';
  assert.equal(stripAudioTags(s), s);
  assert.equal(hasAudioTags(s), false);
});

test('multi-word tags and case are handled', () => {
  assert.equal(stripAudioTags('[laughs softly] Sure.'), 'Sure.');
  assert.equal(stripAudioTags('[LAUGHS] Sure.'), 'Sure.');
});

test('voice keeps tags when supported and drops them when not', () => {
  const line = '[laughs] Found it.';
  assert.equal(forVoice(line, true), line);
  assert.equal(forVoice(line, false), 'Found it.');
});

test('a line that is only a tag collapses to empty', () => {
  assert.equal(stripAudioTags('[sighs]'), '');
});

test('silence filler never reaches the director', () => {
  for (const noise of ['...', '…', '.', '  ', '?!', '-', '[BLANK_AUDIO]', '(silence)', '[inaudible]']) {
    assert.equal(isMeaningfulUtterance(noise), false, `should ignore ${JSON.stringify(noise)}`);
  }
});

test('real speech gets through, including short answers', () => {
  for (const said of ['yes', 'No.', 'ok', "what's pending?", '175', 'mm hmm']) {
    assert.equal(isMeaningfulUtterance(said), true, `should forward ${JSON.stringify(said)}`);
  }
});
