import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keyterms, parseKeyterms, projectTerms, dependencyTerms, mineRepo, MAX_TERMS } from './keyterms.ts';

/** A repo shaped like the two real ones: a .NET tree and a pnpm workspace. */
function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-keyterms-'));
  const mk = (p: string) => fs.mkdirSync(path.join(dir, p), { recursive: true });
  for (const d of ['src/Music.Core', 'src/Music.Core.Tests', 'src/Music.LiveAudition', 'src/notes', 'apps/lexicon-factory', 'node_modules/left-pad', '.git/objects'])
    mk(d);
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ dependencies: { '@colyseus/sdk': '1', 'pino-pretty': '2', mongoose: '3' }, devDependencies: { vitest: '4' } })
  );
  fs.writeFileSync(path.join(dir, 'apps/lexicon-factory/package.json'), JSON.stringify({ dependencies: { bullmq: '1' } }));
  return dir;
}

test('a compound directory name is a spoken phrase, not a path', () => {
  // "Music.Core" is never said with the dot in it, and CamelCase is not a sound.
  const terms = projectTerms(repo());
  assert.ok(terms.includes('Music Core'));
  assert.ok(terms.includes('Music Live Audition'), `got ${terms.join(', ')}`);
});

test('a test project does not spend a slot restating the thing it tests', () => {
  assert.ok(!projectTerms(repo()).includes('Music Core Tests'));
});

// The rule that does the real work. Nothing structural separates "colyseus" from
// "mockups" — so the auto-derived half only takes made-up compound names, and
// single English words are left to HARNESS_KEYTERMS.
test('a single ordinary word is NOT auto-boosted, however it is spelled', () => {
  const terms = projectTerms(repo());
  assert.ok(!terms.includes('notes'), 'boosting "notes" makes it likelier where it was not said');
});

test('node_modules and dot-directories are not vocabulary', () => {
  const terms = projectTerms(repo());
  assert.ok(!terms.some((t) => /left pad|objects/.test(t)));
});

test('a scoped package gives the SCOPE — that is the word he says', () => {
  const deps = dependencyTerms(repo());
  assert.ok(deps.includes('colyseus'), `got ${deps.join(', ')}`);
  assert.ok(!deps.some((d) => d.includes('sdk')));
});

test('a suffixed package gives the stem, and nested workspaces are found', () => {
  const deps = dependencyTerms(repo());
  assert.ok(deps.includes('pino'), 'pino-pretty is packaging around a noun');
  assert.ok(deps.includes('bullmq'), 'a package.json one level down still counts');
});

test('configured terms come FIRST — they are the only source with a person behind them', () => {
  const { terms } = keyterms({ configured: ['Danny', 'Tulito'], live: ['the context diet plan'], mined: ['Music Core'] });
  assert.deepEqual(terms.slice(0, 2), ['Danny', 'Tulito']);
});

test('the same noun from two sources spends one slot', () => {
  const { terms } = keyterms({ configured: ['colyseus'], mined: ['Colyseus', 'colyseus'] });
  assert.deepEqual(terms, ['colyseus'], 'case-insensitive, first spelling wins');
});

test('generic packaging words are not worth a slot', () => {
  const { terms } = keyterms({ mined: ['src utils', 'types node', 'lexicon factory'] });
  assert.deepEqual(terms, ['lexicon factory']);
});

test('the cap is reported, never silent', () => {
  const many = Array.from({ length: MAX_TERMS + 12 }, (_, i) => `made up term ${i}`);
  const { terms, dropped } = keyterms({ mined: many });
  assert.equal(terms.length, MAX_TERMS);
  assert.equal(dropped, 12);
});

test('what he configured survives the cap — it is what he chose to say', () => {
  const many = Array.from({ length: MAX_TERMS + 5 }, (_, i) => `made up term ${i}`);
  const { terms } = keyterms({ configured: ['colyseus'], mined: many });
  assert.equal(terms[0], 'colyseus');
});

test('a repo it cannot read yields nothing rather than throwing', () => {
  assert.deepEqual(mineRepo('/no/such/repo/anywhere'), []);
});

test('the env list is comma-separated and tolerant of spacing', () => {
  assert.deepEqual(parseKeyterms(' pnpm, colyseus ,Music Core,, '), ['pnpm', 'colyseus', 'Music Core']);
  assert.deepEqual(parseKeyterms(undefined), []);
});

test('what he typed is boosted VERBATIM — only derived names are normalised', () => {
  // "SkiaSharp" → "Skia Sharp" may even be the better phrase, but it is his call:
  // he is the one who can hear whether it worked.
  const { terms } = keyterms({ configured: ['SkiaSharp', 'Music.Core'], mined: ['Music.Notation'] });
  assert.deepEqual(terms, ['SkiaSharp', 'Music.Core', 'Music Notation']);
});

test('a plan name that is a whole sentence is not a keyterm', () => {
  // Biasing toward a sentence biases toward nothing: the words in it are ordinary
  // and it will never be said twice the same way.
  const { terms } = keyterms({
    live: ['Port the beadgame plans workflow + director mode to Tulito', 'Notation view'],
  });
  assert.deepEqual(terms, ['Notation view']);
});
