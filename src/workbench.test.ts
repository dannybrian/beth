import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workbench, vetBenchUrl } from './workbench.ts';

const stateDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-bench-'));
const bench = (dir = stateDir()) => new Workbench({ stateDir: dir });

// ⚠️ The reason this module has tests at all: the page hands this straight to
// an <a href> in the boldest spot on the screen, in every open tab.
test('only http(s) gets onto the bench', () => {
  assert.ok(vetBenchUrl('http://localhost:3000').ok);
  assert.ok(vetBenchUrl('https://staging.example.com/games/4?seat=2').ok);
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'vscode://file/x', 'data:text/html,hi']) {
    const v = vetBenchUrl(bad);
    assert.equal(v.ok, false, bad);
    assert.match((v as { reason: string }).reason, /only http/);
  }
});

// Where the first version of this failed: "localhost:3000" parses with scheme
// `localhost:`, so the most natural input of all was refused with a message
// blaming a protocol nobody wrote.
test('a scheme-less host:port is taken as http, not refused', () => {
  const v = vetBenchUrl('localhost:3000/board');
  assert.deepEqual(v, { ok: true, url: 'http://localhost:3000/board' });
});

test('a non-url is refused with a reason and an example', () => {
  const v = vetBenchUrl('not a url at all');
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /localhost:3000/);
});

test('the bench survives a restart — the dev server it points at usually does too', () => {
  const dir = stateDir();
  bench(dir).set('http://localhost:5173/board', 'the board');
  const b = bench(dir);
  assert.equal(b.current()?.url, 'http://localhost:5173/board');
  assert.equal(b.current()?.label, 'the board');
});

test('one slot: setting replaces, clearing reports what left', () => {
  const b = bench();
  b.set('http://localhost:3000');
  b.set('http://localhost:3000/lobby', 'lobby');
  assert.equal(b.current()?.url, 'http://localhost:3000/lobby');
  assert.equal(b.clear()?.url, 'http://localhost:3000/lobby');
  assert.equal(b.current(), null);
  assert.equal(b.clear(), null, 'clearing an empty bench is nothing, not an error');
});

test('a rejected url leaves the bench exactly as it was', () => {
  const b = bench();
  b.set('http://localhost:3000');
  assert.equal(b.set('javascript:alert(1)').ok, false);
  assert.equal(b.current()?.url, 'http://localhost:3000/');
});

test('an empty or whitespace label is no label, not a blank one', () => {
  const b = bench();
  b.set('http://localhost:3000', '   ');
  assert.equal(b.current()?.label, undefined);
  assert.equal(b.message().label, undefined);
});

// The file is ours, but the page's safety must not rest on that: a hand-edited
// or corrupt file must not smuggle in what set() refuses.
test('a tampered or unreadable state file starts empty rather than trusted', () => {
  const dir = stateDir();
  fs.writeFileSync(path.join(dir, 'workbench.json'), JSON.stringify({ url: 'javascript:alert(1)' }));
  assert.equal(bench(dir).current(), null);
  fs.writeFileSync(path.join(dir, 'workbench.json'), 'not json');
  assert.equal(bench(dir).current(), null);
});

test('the message is one shape, occupied or empty, so the page has one handler', () => {
  const b = bench();
  assert.deepEqual(b.message(), { type: 'workbench', url: null, label: undefined, source: undefined });
  b.set('http://localhost:3000', 'game');
  assert.deepEqual(b.message(), { type: 'workbench', url: 'http://localhost:3000/', label: 'game', source: 'pin' });
});

// The run button shares the one slot, and the two rules below are what stop
// it trampling his attention: a run never displaces a pin, and a stop only
// takes down what a run put up.
test('a run takes an empty bench, never a pin', () => {
  const b = bench();
  assert.equal(b.offerRun('http://127.0.0.1:5178/'), true);
  assert.equal(b.current()!.source, 'run');
  b.set('https://github.com/x/y/pull/4', 'the PR');
  assert.equal(b.offerRun('http://127.0.0.1:5178/'), false);
  assert.equal(b.current()!.url, 'https://github.com/x/y/pull/4');
});

test('a stop clears its own url and leaves a pin alone', () => {
  const b = bench();
  b.offerRun('http://127.0.0.1:5178/');
  assert.equal(b.clearRun(), true);
  assert.equal(b.current(), null);
  b.set('http://localhost:3000');
  assert.equal(b.clearRun(), false);
  assert.equal(b.current()!.url, 'http://localhost:3000/');
});

test('a run url replaces an earlier run, and the source survives a restart', () => {
  const dir = stateDir();
  const b = bench(dir);
  b.offerRun('http://127.0.0.1:5178/');
  assert.equal(b.offerRun('http://127.0.0.1:5180/'), true);
  assert.equal(b.offerRun('http://127.0.0.1:5180/'), false, 'no change, nothing to publish');
  assert.equal(bench(dir).current()!.source, 'run');
  // A file written before runs existed is a pin, so a stop never clears it.
  fs.writeFileSync(path.join(dir, 'workbench.json'), JSON.stringify({ url: 'http://localhost:1/', setAt: '' }));
  assert.equal(bench(dir).clearRun(), false);
});
