import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { directorName, UNNAMED } from './directorName.ts';

/** A throwaway repo with (or without) a director guide. */
function repoWith(guide?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dirname-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  if (guide !== undefined) fs.writeFileSync(path.join(dir, '.claude', 'DIRECTOR.md'), guide);
  return dir;
}

test('the name comes from the way a repo already writes it', () => {
  assert.equal(directorName(repoWith('You are **Beth**. You work with **Danny**.')), 'Beth');
  assert.equal(directorName(repoWith('You are Ada, the standing director.')), 'Ada');
  assert.equal(directorName(repoWith('# Director\n\nYour name is **Rue**.')), 'Rue');
});

// The sentence the HARNESS writes about every director, which must never be
// mistaken for a name.
test('a role sentence is not a name', () => {
  assert.equal(directorName(repoWith('You are the standing director on this project.')), UNNAMED);
});

test('no guide, or an unnamed one, yields a competent stranger', () => {
  assert.equal(directorName(repoWith()), UNNAMED);
  assert.equal(directorName(repoWith('Ship carefully. Never force a claim.')), UNNAMED);
  assert.equal(directorName('/nonexistent/repo'), UNNAMED);
});

test('an explicit override wins over whatever the file says', () => {
  assert.equal(directorName(repoWith('You are **Beth**.'), 'Vera'), 'Vera');
  assert.equal(directorName(repoWith('You are **Beth**.'), '  '), 'Beth', 'blank is not an override');
});
