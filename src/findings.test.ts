// The read state behind the digest — where a mistake is a backlog read out as
// news on the first boot, or a finding that vanishes because it was "read".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FindingsRead } from './findings.ts';
import type { WorkFinding, WorkItem } from './workItems.ts';

const f = (id: string, date: string, line = 1): WorkFinding => ({ id, date, text: `t ${id}`, adds: `a ${id}`, line });
const item = (p: string, status: WorkItem['status'], findings: WorkFinding[]) =>
  ({ path: p, spoken: p.replace(/\.md$/, ''), status, findings, tasks: [], tags: [] }) as unknown as WorkItem;

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'findings-'));

test('the first boot reads what is already there as read — and only the first', () => {
  const stateDir = dir();
  const before = [item('a.md', 'shipped', [f('a#1', '2026-11-01')])];
  const r = new FindingsRead({ stateDir });
  r.seed(before);
  assert.deepEqual(r.rows(before, { unreadOnly: true }), []);

  // A restart is not a first boot: something new stays new.
  const after = [item('a.md', 'shipped', [f('a#1', '2026-11-01'), f('a#2', '2026-11-02')])];
  const again = new FindingsRead({ stateDir });
  again.seed(after);
  assert.deepEqual(again.rows(after, { unreadOnly: true }).map((x) => x.id), ['a#2']);
});

test('finished plans count, newest first, and read ones stay reachable', () => {
  const r = new FindingsRead({ stateDir: dir() });
  r.seed([]);
  const items = [
    item('shipped.md', 'shipped', [f('s#1', '2026-11-01', 9), f('s#2', '2026-11-02', 40)]),
    item('active.md', 'active', [f('x#1', '2026-11-02', 3)]),
  ];
  assert.deepEqual(r.rows(items, { unreadOnly: true }).map((x) => x.id), ['x#1', 's#2', 's#1']);
  r.markRead(['s#2']);
  assert.deepEqual(r.rows(items, { unreadOnly: true }).map((x) => x.id), ['x#1', 's#1']);
  const all = r.rows(items);
  assert.equal(all.length, 3);
  assert.equal(all.find((x) => x.id === 's#2')?.read, true);
  assert.equal(all[0].plan, 'active');
  r.markAll(items);
  assert.deepEqual(r.rows(items, { unreadOnly: true }), []);
  assert.deepEqual(new FindingsRead({ stateDir: (r as any).file.replace(/\/findings-read\.json$/, '') }).rows(items, { unreadOnly: true }), [], 'it survives a restart');
});
