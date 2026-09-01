import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectLinks } from './links.ts';

function fixture(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'links-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'config.ts'), '');
  fs.writeFileSync(path.join(repo, 'README.md'), '');
  return repo;
}

const plans = new Map([['plans/2026-08-01-context-diet.md', { spoken: 'the context diet plan' }]]);
const deps = (repo: string) => ({ repo, lookup: (p: string) => plans.get(p) });

test('a path in the work index links as a plan, carrying its spoken name', () => {
  const repo = fixture();
  const text = 'I moved that into plans/2026-08-01-context-diet.md this morning.';
  const [link] = detectLinks(text, deps(repo));
  assert.equal(link.kind, 'plan');
  assert.equal(link.spoken, 'the context diet plan');
  assert.equal(text.slice(link.start, link.end), 'plans/2026-08-01-context-diet.md');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('a real file links, with its line number when given', () => {
  const repo = fixture();
  const links = detectLinks('the guard is in src/config.ts:42 now', deps(repo));
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, 'file');
  assert.equal(links[0].path, 'src/config.ts');
  assert.equal(links[0].line, 42);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('a path that does not exist is not linked', () => {
  // The whole point: a link is only offered when it can be proven to resolve.
  const repo = fixture();
  assert.deepEqual(detectLinks('try src/nope.ts or plans/imaginary.md', deps(repo)), []);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('ordinary prose is not mistaken for paths', () => {
  const repo = fixture();
  const text = 'e.g. we went from 1.2 to 3.5x faster, i.e. roughly double. See vs. the old one.';
  assert.deepEqual(detectLinks(text, deps(repo)), []);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('a bare filename links only when it really exists at the repo root', () => {
  const repo = fixture();
  const links = detectLinks('it is in README.md, not in NOTES.md', deps(repo));
  assert.deepEqual(
    links.map((l) => l.path),
    ['README.md']
  );
  fs.rmSync(repo, { recursive: true, force: true });
});

test('a directory is not a file link', () => {
  const repo = fixture();
  fs.mkdirSync(path.join(repo, 'weird.dir'));
  assert.deepEqual(detectLinks('look in weird.dir for it', deps(repo)), []);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('paths cannot escape the repo', () => {
  // ../../etc/hosts exists on this machine; it must never become a link.
  const repo = fixture();
  assert.deepEqual(detectLinks('see ../../../../etc/hosts for that', deps(repo)), []);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('offsets are exact, so several links in one line splice correctly', () => {
  const repo = fixture();
  const text = 'both README.md and src/config.ts:7 changed';
  const links = detectLinks(text, deps(repo));
  assert.equal(links.length, 2);
  for (const l of links) {
    const slice = text.slice(l.start, l.end);
    assert.ok(slice.startsWith(l.path), `${slice} should start with ${l.path}`);
  }
  // Non-overlapping and in order — the renderer walks them sequentially.
  assert.ok(links[0].end <= links[1].start);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('a URL is not shredded into file links', () => {
  const repo = fixture();
  assert.deepEqual(detectLinks('see https://example.com/README.md for context', deps(repo)), []);
  fs.rmSync(repo, { recursive: true, force: true });
});

// --- plans cited by number ---------------------------------------------------
//
// The reference agents actually use, and the one Danny could not follow: the
// worker says "Implement plan 176 headless stretch" and the panel says titles.

const numbered = new Map<number, { path: string; spoken: string }>([
  [174, { path: 'game/plans/unity/2026-07-30-174-menu-fluidity.md', spoken: 'menu fluidity' }],
  [176, { path: 'game/plans/unity/2026-08-06-176-book-in-world.md', spoken: 'book in world' }],
]);
const numDeps = (repo: string) => ({
  repo,
  lookup: (p: string) => plans.get(p),
  // 22 is the ambiguous case: unity and backend both have one.
  lookupNumber: (n: number) => (n === 22 ? undefined : numbered.get(n)),
});

test('a cited plan number becomes a link over the whole phrase', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'links-'));
  const text = "I've recorded the approval in plan 174.";
  const [l] = detectLinks(text, numDeps(repo));
  assert.equal(text.slice(l.start, l.end), 'plan 174');
  assert.equal(l.path, 'game/plans/unity/2026-07-30-174-menu-fluidity.md');
  assert.equal(l.kind, 'plan');
  assert.equal(l.spoken, 'menu fluidity');
});

test('the forms she actually writes', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'links-'));
  const forms = ['plan 174', 'Plan #174', 'plans 174', '#174'];
  for (const f of forms) {
    const got = detectLinks(`see ${f} for that`, numDeps(repo));
    assert.equal(got.length, 1, `${f} should link`);
    assert.equal(got[0].path, 'game/plans/unity/2026-07-30-174-menu-fluidity.md');
  }
});

test('an AMBIGUOUS number draws nothing at all', () => {
  // beadgame has two plan 22s. A confidently wrong link is worse than none:
  // it looks resolved, so nobody checks it.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'links-'));
  assert.deepEqual(detectLinks('that was plan 22, I think', numDeps(repo)), []);
});

test('a bare number is never a link', () => {
  // All three are real lines from beadgame's own event log.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'links-'));
  for (const t of ['timeout 174 pnpm audit', 'finished in 176 tok', 'exit 174']) {
    assert.deepEqual(detectLinks(t, numDeps(repo)), [], t);
  }
});

test('numbers and paths coexist, in reading order', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'links-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/config.ts'), '');
  const text = 'plan 176 touches src/config.ts and supersedes plan 174';
  const got = detectLinks(text, numDeps(repo));
  assert.deepEqual(
    got.map((l) => text.slice(l.start, l.end)),
    ['plan 176', 'src/config.ts', 'plan 174'],
    'offsets must be ascending or the page splices scrambled'
  );
});
