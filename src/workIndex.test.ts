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
 *
 * The DEADLINE is generous for the same reason. `node --test` runs the files in
 * parallel, so a watcher can be waiting on an event while the machine is busy;
 * 4s was enough to go red about once in a dozen full-suite runs while passing
 * every time in isolation. Waiting longer costs nothing when the test passes —
 * this returns the moment the condition holds — and only lengthens real failures.
 */
async function waitFor(fn: () => boolean, ms = 20_000): Promise<boolean> {
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

test('awaiting-eyes reaches the LIVE set and leads the grouping', async () => {
  // Two separate failures were possible here. It has to be in the live set at
  // all — main.ts filters the stream by exactly that, so a status outside it
  // never reaches the panel. And it has to lead: this is Danny's queue, and
  // burying it under thirty active plans is what made it invisible in practice.
  const idx = new WorkIndex([
    {
      name: 'test',
      watchRoots: () => [],
      read: () => [
        { path: 'p/a.md', title: 'Active one', status: 'active' as const, tags: [], claim: null, tasks: [], reader: 't' },
        { path: 'p/e.md', title: 'Eyes one', status: 'awaiting-eyes' as const, tags: [], claim: null, tasks: [], reader: 't' },
        { path: 'p/s.md', title: 'Shipped one', status: 'shipped' as const, tags: [], claim: null, tasks: [], reader: 't' },
      ],
    },
  ]);
  idx.refresh();

  assert.ok(
    idx.live().some((i) => i.status === 'awaiting-eyes'),
    'must be in the live set or the panel never receives it'
  );
  assert.equal(idx.live().length, 2, 'shipped stays out');
  assert.equal(idx.grouped()[0].status, 'awaiting-eyes', 'leads the panel');

  // …but it is NOT work in progress, and must not be reported as such.
  assert.ok(!idx.inFlight().some((i) => i.status === 'awaiting-eyes'));
  idx.stop();
});

test('review is recognised but stays out of the live panel', async () => {
  // beadgame's plans/README defines review as "an audit assigned it and a human
  // must reclassify" — bookkeeping owed to /tidyrepo, not a deliverable awaiting
  // judgement. Recognised so it stops falling to `unknown`; out of the live set
  // so it does not dilute the confirmation queue.
  const idx = new WorkIndex([
    {
      name: 'test',
      watchRoots: () => [],
      read: () => [
        { path: 'p/r.md', title: 'Reclassify me', status: 'review' as const, tags: [], claim: null, tasks: [], reader: 't' },
      ],
    },
  ]);
  idx.refresh();
  assert.equal(idx.all()[0].status, 'review', 'not unknown');
  assert.deepEqual(idx.live(), []);
  idx.stop();
});

test('pointing is consumed by the turn that uses it, not merely read', async () => {
  // A spoken turn takes the same references a typed one would, so clicking a
  // plan and then TALKING works. Consuming (not peeking) matches the composer
  // chips clearing on send, and stops a reference riding a later, unrelated turn.
  await withIndex(async (idx) => {
    const ref = { kind: 'item' as const, path: 'plans/2026-01-01-alpha.md', spoken: 'Alpha' };
    idx.point([ref]);
    assert.equal(idx.pointed().length, 1);
    assert.deepEqual(idx.takePointed(), [ref]);
    assert.deepEqual(idx.takePointed(), [], 'a second turn gets nothing');
  });
});

test('consuming pointing notifies subscribers so the page drops its chips', async () => {
  await withIndex(async (idx) => {
    const seen: number[] = [];
    idx.onPointingChange((refs) => seen.push(refs.length));
    idx.point([{ kind: 'item', path: 'plans/2026-01-01-alpha.md', spoken: 'Alpha' }]);
    idx.takePointed();
    assert.deepEqual(seen, [0], 'cleared once, and only on consume');
    idx.takePointed();
    assert.deepEqual(seen, [0], 'consuming nothing does not republish');
  });
});

test('a chip-sync that arrives late cannot resurrect a consumed reference', async () => {
  // The real ordering hazard: the page mirrors chips and posts the turn as two
  // separate fetches. If the mirror lands after the turn, a spent reference
  // would silently staple itself to the next SPOKEN turn.
  await withIndex(async (idx) => {
    const ref = { kind: 'item' as const, path: 'plans/2026-01-01-alpha.md', spoken: 'Alpha' };
    idx.point([ref], 100); // the page's chip sync
    idx.point([ref], 101); // the turn carrying the same refs
    idx.takePointed(); // turn consumes them
    idx.point([ref], 100); // the delayed duplicate finally lands
    assert.deepEqual(idx.pointed(), [], 'stale update rejected');
  });
});

test('a DUPLICATE chip-sync at the same seq cannot resurrect it either', async () => {
  // This is the shape that actually bit in a live run: a spoken turn consumes
  // pointing without supplying any seq of its own, so the last seq on record is
  // still the chip sync's. A re-delivered copy carries that same number, and an
  // exclusive `<` comparison waved it straight through onto the next turn.
  await withIndex(async (idx) => {
    const ref = { kind: 'item' as const, path: 'plans/2026-01-01-alpha.md', spoken: 'Alpha' };
    idx.point([ref], 7);
    idx.takePointed(); // a spoken turn — no seq of its own
    idx.point([ref], 7); // the duplicate
    assert.deepEqual(idx.pointed(), [], 'same-seq duplicate rejected');
  });
});

test('a genuinely newer point after a turn is still accepted', async () => {
  await withIndex(async (idx) => {
    idx.point([{ kind: 'item', path: 'plans/2026-01-01-alpha.md', spoken: 'Alpha' }], 100);
    idx.takePointed();
    idx.point([{ kind: 'item', path: 'plans/deep/x.md', spoken: 'Later click' }], 101);
    assert.equal(idx.pointed()[0]?.spoken, 'Later click');
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
