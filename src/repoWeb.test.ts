import test from 'node:test';
import assert from 'node:assert/strict';
import { webHome } from './repoWeb.ts';

// A wrong parse here renders a link that looks resolved and opens a 404 —
// nobody checks a link that has an href.
test('every spelling of a github origin lands on the same home page', () => {
  const home = 'https://github.com/dbrian/beth';
  for (const remote of [
    'git@github.com:dbrian/beth.git',
    'git@github.com:dbrian/beth',
    'ssh://git@github.com/dbrian/beth.git',
    'https://github.com/dbrian/beth.git',
    'https://github.com/dbrian/beth',
    'https://danny@github.com/dbrian/beth.git',
    'git://github.com/dbrian/beth.git',
    '  https://github.com/dbrian/beth/  \n',
  ]) {
    assert.equal(webHome(remote), home, remote);
  }
});

test('other forges are accepted at the root, labelled by host', () => {
  assert.equal(webHome('git@gitlab.com:group/proj.git'), 'https://gitlab.com/group/proj');
  assert.equal(webHome('https://codeberg.org/x/y.git'), 'https://codeberg.org/x/y');
  assert.equal(webHome('ssh://git@git.example.com:2222/x/y.git'), 'https://git.example.com/x/y');
});

test('a remote with no page behind it is null, not a guess', () => {
  assert.equal(webHome(''), null);
  assert.equal(webHome('/Users/dbrian/mirrors/beth.git'), null);
  assert.equal(webHome('../beth'), null);
  assert.equal(webHome('work:dbrian/beth.git'), null, 'an ssh alias is not a host');
  assert.equal(webHome('git@gitlab.com:group/sub/proj.git'), null, 'a subgroup is not owner/repo');
  assert.equal(webHome('https://github.com/dbrian'), null, 'an owner is not a repo');
});
