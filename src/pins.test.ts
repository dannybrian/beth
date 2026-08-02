import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pins, workMessage } from './pins.ts';
import type { WorkIndex } from './workIndex.ts';
import type { WorkItem } from './workItems.ts';

const stateDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pins-'));
const pins = (dir = stateDir()) => new Pins({ stateDir: dir });

const item = (p: string, status = 'active') => ({ path: p, spoken: p, status, tasks: [] }) as unknown as WorkItem;
const index = (items: WorkItem[]) => ({ all: () => items }) as unknown as WorkIndex;

test('a pin survives a restart — that is the whole point of a shelf', () => {
  const dir = stateDir();
  pins(dir).set('plans/a.md', true);
  // A second Pins over the same state dir is what a restart looks like.
  assert.deepEqual(pins(dir).all(), ['plans/a.md']);
});

test('pin order is insertion order, so the shelf does not reshuffle itself', () => {
  const p = pins();
  p.set('plans/b.md', true);
  p.set('plans/a.md', true);
  assert.deepEqual(p.all(), ['plans/b.md', 'plans/a.md']);
});

test('pinning twice is one pin, unpinning what is not pinned is nothing', () => {
  const p = pins();
  p.set('plans/a.md', true);
  p.set('plans/a.md', true);
  assert.deepEqual(p.all(), ['plans/a.md']);
  p.set('plans/never.md', false);
  assert.deepEqual(p.all(), ['plans/a.md']);
});

test('toggle reports the state it landed on', () => {
  const p = pins();
  assert.equal(p.toggle('plans/a.md'), true);
  assert.equal(p.toggle('plans/a.md'), false);
  assert.deepEqual(p.all(), []);
});

test('an unreadable or absent pins file starts empty rather than throwing', () => {
  const dir = stateDir();
  fs.writeFileSync(path.join(dir, 'pins.json'), 'not json at all');
  assert.deepEqual(pins(dir).all(), []);
});

// ⚠️ The reason pins are resolved server-side: the stream carries only the
// in-flight slice, and the plans worth shelving are frequently not in it.
test('a pinned plan that is NOT live still reaches the page', () => {
  const p = pins();
  p.set('plans/shipped.md', true);
  const work = index([item('plans/active.md', 'active'), item('plans/shipped.md', 'shipped')]);
  const m = workMessage(work, p);
  assert.deepEqual(m.items.map((i) => i.path), ['plans/active.md'], 'the live slice is unchanged');
  assert.deepEqual(m.pinned.map((i) => i.path), ['plans/shipped.md']);
});

test('a pinned plan is ALSO still in its status group — a pin is not a move', () => {
  const p = pins();
  p.set('plans/active.md', true);
  const m = workMessage(index([item('plans/active.md', 'active')]), p);
  assert.deepEqual(m.items.map((i) => i.path), ['plans/active.md']);
  assert.deepEqual(m.pinned.map((i) => i.path), ['plans/active.md']);
});

test('a pin whose plan has gone is skipped, not fatal, and stays on file', () => {
  const p = pins();
  p.set('plans/deleted.md', true);
  p.set('plans/a.md', true);
  const m = workMessage(index([item('plans/a.md')]), p);
  assert.deepEqual(m.pinned.map((i) => i.path), ['plans/a.md']);
  assert.ok(p.has('plans/deleted.md'), 'kept in case the plan comes back');
});

test('the total counts every plan, not just what is shown', () => {
  const m = workMessage(index([item('plans/a.md', 'active'), item('plans/b.md', 'shipped')]), pins());
  assert.equal(m.total, 2);
  assert.equal(m.items.length, 1);
});
