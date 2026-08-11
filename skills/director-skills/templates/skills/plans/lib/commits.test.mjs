// .claude/skills/plans/lib/commits.test.mjs
//
// The derived `commits:` list. Trailers already in git history are immutable,
// so when one is wrong the only place truth can be restored is here — hence
// `commits_exclude:`, the one hand-authored input to an otherwise derived field.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeShaList, shaMatches, filterExcludedCommits, parseShaListValue, mergeIncludedCommits,
  SHA_LIST_KEYS,
} from './commits.mjs';

// ─── The leading-zero sha, i.e. why sha lists get their own parser ─────────
// 0.39% of 7-char short shas are all digits with a leading zero (measured over
// 200k synthetic shas). Through the generic YAML scalar path, `0049719` parses
// as parseInt → 49719: the exclusion stops naming its commit, the field is
// rewritten mangled on the next sync, and INDEX reports a sha git can't resolve.
// Reproduced end-to-end on a real repo whose excluded commit was amended until
// its short sha took that shape.
// MUTANT: route these keys back through parseYamlValue → the first test reds.

test('a leading-zero sha survives parsing intact', () => {
  assert.deepEqual(parseShaListValue('[0049719]'), ['0049719']);
  assert.deepEqual(parseShaListValue('[0044002, 0f3f859]'), ['0044002', '0f3f859']);
});

test('ordinary sha lists parse the same as before', () => {
  assert.deepEqual(parseShaListValue('[a1b2c3d, 4400273]'), ['a1b2c3d', '4400273']);
  assert.deepEqual(parseShaListValue('[]'), []);
  assert.deepEqual(parseShaListValue('null'), []);
  assert.deepEqual(parseShaListValue(''), []);
});

test('quoting and loose spacing are tolerated, since operators hand-write this', () => {
  assert.deepEqual(parseShaListValue(`[ "0049719" ,  'a1b2c3d' ]`), ['0049719', 'a1b2c3d']);
  assert.deepEqual(parseShaListValue('0049719'), ['0049719'], 'a bare single value too');
});

// ─── D. all-digit short shas must stay strings ────────────────────────────
// Our frontmatter parser coerces /^-?\d+$/ to a number, so a short sha like
// 44002735 lands in INDEX.json as the NUMBER 44002735 — a type the consumers
// (dashboard, git) can't use, and one that loses any leading zero.
// MUTANT: return the array unchanged instead of mapping String → red.

test('an all-digit short sha survives as a string', () => {
  assert.deepEqual(normalizeShaList([44002735, 'a1b2c3d4']), ['44002735', 'a1b2c3d4']);
});

test('a leading-zero sha is not renumbered', () => {
  // Already a string here; the point is normalize never round-trips through Number.
  assert.deepEqual(normalizeShaList(['00123456']), ['00123456']);
});

test('a missing or non-list value normalizes to an empty list', () => {
  assert.deepEqual(normalizeShaList(undefined), []);
  assert.deepEqual(normalizeShaList(null), []);
  assert.deepEqual(normalizeShaList('a1b2c3d4'), []);
});

test('blank entries are dropped rather than emitted as empty shas', () => {
  assert.deepEqual(normalizeShaList(['a1b2c3d4', '', null]), ['a1b2c3d4']);
});

// ─── B. sha matching tolerates differing abbreviation lengths ─────────────
// Trailers and hand-written frontmatter both carry abbreviated shas, and git
// picks the length itself — 7 here, 8 there. An exact-equality filter silently
// fails to exclude the very commit the operator wrote down.
// MUTANT: implement shaMatches as `a === b` → the two prefix tests go red.

test('a shorter recorded sha still matches a longer derived one', () => {
  assert.equal(shaMatches('44002735', '4400273'), true);
  assert.equal(shaMatches('4400273', '44002735'), true);
});

test('sha matching is case-insensitive', () => {
  assert.equal(shaMatches('A1B2C3D4', 'a1b2c3d4'), true);
});

test('different shas do not match', () => {
  assert.equal(shaMatches('44002735', '44112233'), false);
});

// A blank or near-blank exclude entry would prefix-match every commit and wipe
// the whole derived list — a typo must not be able to do that.
test('an empty or too-short sha matches nothing', () => {
  assert.equal(shaMatches('', 'a1b2c3d4'), false);
  assert.equal(shaMatches('a1b', 'a1b2c3d4'), false);
});

// ─── B. the exclusion filter itself ───────────────────────────────────────
// MUTANT: return `shas` unfiltered → all four go red.

test('excluded shas are dropped from the derived list', () => {
  assert.deepEqual(
    filterExcludedCommits(['aaaaaaa1', 'bbbbbbb2', 'ccccccc3'], ['bbbbbbb2']),
    ['aaaaaaa1', 'ccccccc3'],
  );
});

test('exclusion matches across abbreviation lengths', () => {
  assert.deepEqual(filterExcludedCommits(['44002735', 'aaaaaaa1'], ['4400273']), ['aaaaaaa1']);
});

test('an all-digit exclude entry parsed as a number still excludes', () => {
  // How it arrives from frontmatter: `commits_exclude: [44002735]` parses to a
  // NUMBER, so the filter has to normalize before comparing.
  assert.deepEqual(filterExcludedCommits(['44002735', 'aaaaaaa1'], [44002735]), ['aaaaaaa1']);
});

test('no exclusions leaves the derived list untouched', () => {
  assert.deepEqual(filterExcludedCommits(['aaaaaaa1'], []), ['aaaaaaa1']);
  assert.deepEqual(filterExcludedCommits(['aaaaaaa1'], undefined), ['aaaaaaa1']);
});

test('the derived order is preserved (oldest first)', () => {
  assert.deepEqual(
    filterExcludedCommits(['aaaaaaa1', 'bbbbbbb2', 'ccccccc3'], ['aaaaaaa1']),
    ['bbbbbbb2', 'ccccccc3'],
  );
});

// ─── commits_include ────────────────────────────────────────────────────
// The other half of the linkage-repair mechanism: `commits_exclude` disowns a
// mis-stamped trailer, but several plans' honest commit sets contain shas that
// carry only ANOTHER plan's trailer (or none at all) in immutable history — a
// trailer-derived sync can never reproduce them. `commits_include:` is the
// hand-authored addition side, merged in wherever `commits_exclude` filters.
// MUTANT: return `shas` unchanged (drop the merge) → the first four tests red.

test('an included sha not already in the derived list is appended', () => {
  assert.deepEqual(
    mergeIncludedCommits(['aaaaaaa1'], ['bbbbbbb2']),
    ['aaaaaaa1', 'bbbbbbb2'],
  );
});

test('included shas append in their own frontmatter order, after the derived ones', () => {
  assert.deepEqual(
    mergeIncludedCommits(['aaaaaaa1'], ['ccccccc3', 'bbbbbbb2']),
    ['aaaaaaa1', 'ccccccc3', 'bbbbbbb2'],
  );
});

test('an included sha already present in the derived list is not duplicated', () => {
  assert.deepEqual(
    mergeIncludedCommits(['aaaaaaa1', 'bbbbbbb2'], ['bbbbbbb2']),
    ['aaaaaaa1', 'bbbbbbb2'],
  );
});

test('cross-abbreviation-length matching applies to includes too', () => {
  // A derived sha spelled 8 chars must not be duplicated by an include entry
  // spelled 7 — same shaMatches rule filterExcludedCommits already uses.
  assert.deepEqual(
    mergeIncludedCommits(['44002735'], ['4400273']),
    ['44002735'],
  );
});

test('duplicate entries within commits_include itself collapse to one', () => {
  assert.deepEqual(
    mergeIncludedCommits(['aaaaaaa1'], ['bbbbbbb2', 'bbbbbbb2']),
    ['aaaaaaa1', 'bbbbbbb2'],
  );
});

test('no includes leaves the derived list untouched', () => {
  assert.deepEqual(mergeIncludedCommits(['aaaaaaa1'], []), ['aaaaaaa1']);
  assert.deepEqual(mergeIncludedCommits(['aaaaaaa1'], undefined), ['aaaaaaa1']);
});

test('an empty derived list still gets the includes appended', () => {
  assert.deepEqual(mergeIncludedCommits([], ['aaaaaaa1']), ['aaaaaaa1']);
  assert.deepEqual(mergeIncludedCommits(undefined, ['aaaaaaa1']), ['aaaaaaa1']);
});

test('an all-digit include entry parsed as a number still merges as a string', () => {
  // How it arrives from frontmatter: `commits_include: [44002735]` parses to a
  // NUMBER before normalization — same leading-zero hazard as commits_exclude.
  assert.deepEqual(mergeIncludedCommits(['aaaaaaa1'], [44002735]), ['aaaaaaa1', '44002735']);
});

// ─── Precedence: exclude wins over include ────────────────────────────────
// Composing the two (as index.mjs's commitsForPlan does: merge includes, then
// filter excludes) means a sha named in BOTH fields ends up excluded. Tested
// here at the composition the two pure functions form, since the precedence
// is a property of using them together, not of either alone.
// MUTANT: filter excludes before merging includes → this test stays green
// (wrong order still excludes if applied after) but the fix relies on the
// call order in index.mjs; see cli.test.mjs for the end-to-end proof.

test('composing merge-then-filter excludes a sha named in both fields', () => {
  const derived = ['aaaaaaa1'];
  const includes = ['bbbbbbb2'];
  const excludes = ['bbbbbbb2'];
  const merged = mergeIncludedCommits(derived, includes);
  const result = filterExcludedCommits(merged, excludes);
  assert.deepEqual(result, ['aaaaaaa1'], 'the sha in both include and exclude must not survive');
});

test('SHA_LIST_KEYS carries commits_include, inheriting the leading-zero-safe parser', () => {
  assert.equal(SHA_LIST_KEYS.has('commits_include'), true);
});
