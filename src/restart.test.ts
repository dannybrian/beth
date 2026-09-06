import test from 'node:test';
import assert from 'node:assert/strict';
import { RESTART_EXIT, restartVerdict } from './restart.ts';
import fs from 'node:fs';

test('a restart is refused mid-turn and while workers run — the two invisible ways it destroys work', () => {
  assert.equal(restartVerdict({ busy: false, workers: 0 }).ok, true);
  const mid = restartVerdict({ busy: true, workers: 0 });
  assert.equal(mid.ok, false);
  assert.match((mid as { reason: string }).reason, /turn is in flight/);
  const w = restartVerdict({ busy: false, workers: 2 });
  assert.equal(w.ok, false);
  assert.match((w as { reason: string }).reason, /2 workers are running/);
});

/** The two sides of the contract must agree, and nothing else checks they do. */
test('the wrapper relaunches on the code the harness exits with', () => {
  const wrapper = fs.readFileSync(new URL('../bin/beth.mjs', import.meta.url), 'utf8');
  assert.match(wrapper, new RegExp(`RESTART_EXIT = ${RESTART_EXIT};`));
});
