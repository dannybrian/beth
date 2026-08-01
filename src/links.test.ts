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
