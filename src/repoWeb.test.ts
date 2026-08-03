// A remote parsed wrong does not fail — it opens a plausible 404, which is the
// kind of mistake nobody reports and everybody stops trusting the button over.
// The scp-style form is the one that matters: it is what this repo's own origin
// is, and it is the form `new URL()` gets confidently wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webBase, blobUrl } from './repoWeb.ts';

const HERE = new URL('..', import.meta.url).pathname;

test('every spelling of the same github remote reduces to one base', () => {
  const want = 'https://github.com/dannybrian/director-harness';
  for (const remote of [
    // The real one, from `git remote -v` in this repo.
    'git@github.com:dannybrian/director-harness.git',
    'git@github.com:dannybrian/director-harness',
    'ssh://git@github.com/dannybrian/director-harness.git',
    'https://github.com/dannybrian/director-harness.git',
    'https://github.com/dannybrian/director-harness',
    'http://github.com/dannybrian/director-harness/',
    'git://github.com/dannybrian/director-harness.git',
  ]) {
    assert.equal(webBase(remote), want, remote);
  }
});

test('anything whose URL shape we cannot know returns nothing', () => {
  for (const remote of [
    // Not GitHub: the path shape differs (`/-/blob/`) and guessing produces a 404.
    'git@gitlab.com:owner/repo.git',
    'https://bitbucket.org/owner/repo.git',
    // Self-hosted, unknowable from the URL alone.
    'git@github.company.com:owner/repo.git',
    // A gist, or anything else that is not owner/repo.
    'https://github.com/dannybrian',
    'https://github.com/dannybrian/director-harness/tree/main/docs',
    '',
    'not a url',
  ]) {
    assert.equal(webBase(remote), null, remote);
  }
});

test('a path with a space survives as a link rather than as two words', () => {
  const url = blobUrl(HERE, 'plans/a plan.md');
  // This repo has a github origin, so the null branch is not the one under test.
  assert.ok(url, 'expected a url for this repo');
  assert.match(url, /\/blob\/[^/]+\/plans\/a%20plan\.md$/);
});

test('the ref is the branch we are actually standing on', () => {
  const url = blobUrl(HERE, 'README.md');
  const branch = process.env.GITHUB_HEAD_REF || null;
  assert.ok(url);
  // Not asserting WHICH branch — that changes — only that a ref got in and it is
  // not the fixed `main` a first draft would hardcode.
  const ref = /\/blob\/([^/]+)\//.exec(url)?.[1];
  assert.ok(ref && ref !== '', 'no ref in the url');
  if (branch) assert.equal(ref, branch);
});
