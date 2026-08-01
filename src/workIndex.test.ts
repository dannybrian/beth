import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkIndex } from './workIndex.ts';
import { createPlansReader } from './plansReader.ts';

/**
 * Poll rather than sleep a fixed amount. Filesystem events have no guaranteed
 * latency, and a fixed wait is exactly how a watcher test becomes flaky.
 */
async function waitFor(fn: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

function repoFixture(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'work-index-'));
  fs.mkdirSync(path.join(repo, 'plans', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'plans', '2026-01-01-alpha.md'), '---\nstatus: active\n---\n\n# Alpha\n\n- [ ] one\n');
  return repo;
}

const withIndex = async (fn: (idx: WorkIndex, repo: string) => Promise<void>) => {
  const repo = repoFixture();
  const idx = new WorkIndex([createPlansReader({ repo })]);
  idx.start();
  try {
    await fn(idx, repo);
  } finally {
    idx.stop();
    fs.rmSync(repo, { recursive: true, force: true });
  }
};

test('a checkbox ticked on disk reaches the index', async () => {
  await withIndex(async (idx, repo) => {
    assert.equal(idx.byPath('plans/2026-01-01-alpha.md')?.tasks[0].done, false);
    fs.writeFileSync(path.join(repo, 'plans', '2026-01-01-alpha.md'), '---\nstatus: active\n---\n\n# Alpha\n\n- [x] one\n');
    assert.ok(await waitFor(() => idx.byPath('plans/2026-01-01-alpha.md')?.tasks[0].done === true), 'tick not seen');
  });
});

test('a new plan in a nested directory is picked up', async () => {
  // Watching has to be recursive: plans live several levels down, not just at
  // the root of a plans directory.
  await withIndex(async (idx, repo) => {
    fs.writeFileSync(path.join(repo, 'plans', 'deep', '2026-01-02-beta.md'), '---\nstatus: blocked\n---\n\n# Beta\n');
    assert.ok(await waitFor(() => Boolean(idx.byPath('plans/deep/2026-01-02-beta.md'))), 'nested plan not seen');
  });
});

test('a claim landing changes the index without any plan file changing', async () => {
  // The sessions directory is watched for exactly this: `/plans claim` writes a
  // session record, and the panel has to reflect it.
  await withIndex(async (idx, repo) => {
    fs.writeFileSync(
      path.join(repo, 'plans', '2026-01-01-alpha.md'),
      '---\nstatus: active\nowner: claude-x\n---\n\n# Alpha\n\n- [ ] one\n'
    );
    assert.ok(await waitFor(() => idx.byPath('plans/2026-01-01-alpha.md')?.claim?.owner === 'claude-x'));
    assert.equal(idx.byPath('plans/2026-01-01-alpha.md')?.claim?.live, false, 'no session record yet');

    fs.writeFileSync(
      path.join(repo, '.claude', 'sessions', 'claude-x.json'),
      JSON.stringify({ session_id: 'claude-x', plan_path: 'plans/2026-01-01-alpha.md', last_heartbeat: new Date().toISOString() })
    );
    assert.ok(await waitFor(() => idx.byPath('plans/2026-01-01-alpha.md')?.claim?.live === true), 'claim not seen');
  });
});

test('a save that changes nothing visible does not republish', async () => {
  // `/plans tick` rewrites last_touched after every turn of every terminal
  // session. Republishing on each one would rebuild the panel constantly.
  await withIndex(async (idx, repo) => {
    let publishes = 0;
    idx.subscribe(() => publishes++);
    const file = path.join(repo, 'plans', '2026-01-01-alpha.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8'));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(publishes, 0);
  });
});

test('preamble names what was pointed at, and says what to call it', async () => {
  await withIndex(async (idx) => {
    const item = idx.byPath('plans/2026-01-01-alpha.md')!;
    const text = idx.preamble([{ kind: 'item', path: item.path, spoken: item.spoken }]);
    assert.match(text, /pointing at/i);
    assert.match(text, /"Alpha"/);
    assert.match(text, /Never read the path aloud/i);
  });
});

test('preamble reports a plan with no checkboxes as "no tasks"', async () => {
  await withIndex(async (idx, repo) => {
    fs.writeFileSync(path.join(repo, 'plans', 'deep', '2026-01-03-prose.md'), '---\nstatus: active\n---\n\n# Prose only\n\nWords.\n');
    assert.ok(await waitFor(() => Boolean(idx.byPath('plans/deep/2026-01-03-prose.md'))));
    const text = idx.preamble([{ kind: 'item', path: 'plans/deep/2026-01-03-prose.md', spoken: 'Prose only' }]);
    assert.match(text, /no tasks/);
    assert.doesNotMatch(text, /0 of 0|0%/, 'a prose plan is not zero-percent complete');
  });
});

test('a reference to a plan that has gone is reported, not silently dropped', async () => {
  await withIndex(async (idx) => {
    const text = idx.preamble([{ kind: 'item', path: 'plans/vanished.md', spoken: 'the old one' }]);
    assert.match(text, /no longer in the index/);
  });
});

test('spoken names stay unique across every reader in the index', async () => {
  const repo = repoFixture();
  // Two readers producing an identically-titled item — uniqueness is the index's
  // job, not any one reader's.
  const other = {
    name: 'other',
    watchRoots: () => [],
    read: () => [
      { path: 'elsewhere/alpha.md', title: 'Alpha', status: 'active' as const, tags: [], claim: null, tasks: [], reader: 'other' },
    ],
  };
  const idx = new WorkIndex([createPlansReader({ repo }), other]);
  idx.refresh();
  const names = idx.all().map((i) => i.spoken.toLowerCase());
  assert.equal(new Set(names).size, names.length, 'duplicate spoken name across readers');
  idx.stop();
  fs.rmSync(repo, { recursive: true, force: true });
});
