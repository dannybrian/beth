// .claude/skills/plans/lib/testEnv.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanEnv } from './testEnv.mjs';

// MUTANT: drop the prefix check (return {...base, ...overrides}) → red.
test('an inherited PLANS_ knob never reaches the child', () => {
  const env = cleanEnv({}, { PLANS_NO_TRAILER: '1', PATH: '/usr/bin', HOME: '/h' });
  assert.equal('PLANS_NO_TRAILER' in env, false);
  assert.equal(env.PATH, '/usr/bin', 'everything else is passed through untouched');
  assert.equal(env.HOME, '/h');
});

test('a future PLANS_ knob is stripped too, without anyone updating this list', () => {
  const env = cleanEnv({}, { PLANS_SOMETHING_NEW: 'x', TERM_SESSION_ID: 'tab' });
  assert.equal('PLANS_SOMETHING_NEW' in env, false);
  assert.equal(env.TERM_SESSION_ID, 'tab');
});

// The opt-out tests still need to SET the var — stripping must not make it
// unsettable, only unspoken-for.
test('an explicit override wins over the strip', () => {
  const env = cleanEnv({ PLANS_NO_TRAILER: '1' }, { PLANS_NO_TRAILER: '0' });
  assert.equal(env.PLANS_NO_TRAILER, '1');
});

// ─── git's hook environment ───────────────────────────────────────────────
// git exports repo-context vars to its hooks. For a PATHSPEC commit,
// GIT_INDEX_FILE is an ABSOLUTE path to the outer repo's temporary index
// (`.git/next-index-<pid>.lock`) — so a fixture `git commit` that inherits it
// operates against an index whose entries name objects that exist only in the
// outer repo, and dies with `error: invalid object 100755 …`. That aborted a
// real landing commit on 2026-07-30 (the object was .claude/githooks/install.sh
// as staged in the real repo). Plain commits export the RELATIVE `.git/index`,
// which resolves inside the fixture cwd — accidentally harmless, which is why
// only the pathspec commit ever tripped this.
// MUTANT: strip only PLANS_ again → red.
test('inherited GIT_ repo-context vars never reach the child', () => {
  const env = cleanEnv({}, {
    GIT_INDEX_FILE: '/outer/.git/next-index-123.lock',
    GIT_DIR: '/outer/.git',
    GIT_WORK_TREE: '/outer',
    GIT_PREFIX: 'sub/',
    GIT_OBJECT_DIRECTORY: '/outer/.git/objects',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/elsewhere',
    GIT_AUTHOR_DATE: '@1785429317 -0600',
    PATH: '/usr/bin',
  });
  for (const k of Object.keys(env)) {
    assert.equal(k.startsWith('GIT_'), false, `${k} must be stripped`);
  }
  assert.equal(env.PATH, '/usr/bin');
});

// The fixtures' deliberate identity (GIT_AUTHOR_NAME etc.) is an override, and
// overrides are applied after the strip — stated env always survives.
test('a stated GIT_ override survives the strip', () => {
  const env = cleanEnv(
    { GIT_AUTHOR_NAME: 'Fixture' },
    { GIT_AUTHOR_NAME: 'Ambient Author', GIT_INDEX_FILE: '/outer/.git/index' },
  );
  assert.equal(env.GIT_AUTHOR_NAME, 'Fixture');
  assert.equal('GIT_INDEX_FILE' in env, false);
});
