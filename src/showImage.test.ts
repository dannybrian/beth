// The /api/image allowlist is this function — a mistake here is not a broken
// image, it is a query string reading files off the machine. Every refusal is
// tested by geometry (a real file in the wrong place), not by string shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveImage, resolveMarkdown } from './showImage.ts';

const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-img-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'diagram.png'), 'not-really-a-png');
  fs.writeFileSync(path.join(repo, 'docs', 'notes.txt'), 'text');
  // A real image OUTSIDE the repo — the thing traversal would reach.
  fs.writeFileSync(path.join(root, 'secret.png'), 'outside');
  return { root, repo };
};

test('a real image in the repo resolves, with its mime', () => {
  const { repo } = setup();
  const r = resolveImage(repo, 'docs/diagram.png');
  assert.ok(r.ok);
  assert.equal(r.mime, 'image/png');
  assert.equal(r.abs, path.join(repo, 'docs', 'diagram.png'));
});

test('traversal reaches a file that EXISTS and is still refused', () => {
  const { repo } = setup();
  // The point of using a real file: a refusal for "no such file" would pass
  // this test for the wrong reason.
  const r = resolveImage(repo, '../secret.png');
  assert.ok(!r.ok && r.reason === 'outside the repo');
});

test('an absolute path is refused, even to a file inside the repo tree', () => {
  const { root, repo } = setup();
  const abs = resolveImage(repo, path.join(root, 'secret.png'));
  assert.ok(!abs.ok && abs.reason === 'outside the repo');
});

test('a non-image extension is refused before the filesystem is consulted', () => {
  const { repo } = setup();
  const r = resolveImage(repo, 'docs/notes.txt');
  assert.ok(!r.ok && /not an image/.test(r.reason));
});

test('a missing file and a directory are both refused', () => {
  const { repo } = setup();
  assert.ok(!resolveImage(repo, 'docs/gone.png').ok);
  // A directory with an image-shaped name is not a file to serve.
  fs.mkdirSync(path.join(repo, 'shots.png'));
  assert.ok(!resolveImage(repo, 'shots.png').ok);
});

test('an empty path is refused', () => {
  const { repo } = setup();
  assert.ok(!resolveImage(repo, '').ok);
});

// --- markdown, for the in-harness reader ------------------------------------
//
// The same fence as an image, and it matters for the same reason: /api/plan
// builds a response from a query parameter, and loopback is not a licence to
// name any file on the machine. A wrong refusal is a doc that still throws you
// into VSCode; a wrong acceptance is a query string reading the disk.

test('markdown inside the repo reads; anything else does not', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'md-'));
  fs.mkdirSync(path.join(repo, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'plans/a.md'), '# a');
  fs.writeFileSync(path.join(repo, 'README.markdown'), '# r');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'x');

  assert.equal(resolveMarkdown(repo, 'plans/a.md').ok, true);
  assert.equal(resolveMarkdown(repo, 'README.markdown').ok, true);
  // The whole point of the extension gate: a secret is not markdown.
  assert.equal(resolveMarkdown(repo, '.env').ok, false);
  assert.equal(resolveMarkdown(repo, 'notes.txt').ok, false);
  assert.equal(resolveMarkdown(repo, 'plans/missing.md').ok, false);
  assert.equal(resolveMarkdown(repo, '').ok, false);
});

test('traversal and absolute paths die by geometry', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'md-'));
  fs.writeFileSync(path.join(repo, 'ok.md'), '# ok');
  const outside = path.join(os.tmpdir(), `escape-${process.pid}.md`);
  fs.writeFileSync(outside, '# not yours');
  assert.equal(resolveMarkdown(repo, '../../../../etc/passwd.md').ok, false);
  assert.equal(resolveMarkdown(repo, outside).ok, false, 'an absolute path is still outside');
  assert.equal(resolveMarkdown(repo, `../${path.basename(outside)}`).ok, false);
  fs.rmSync(outside, { force: true });
});

test('a directory named like markdown is not a file', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'md-'));
  fs.mkdirSync(path.join(repo, 'weird.md'));
  assert.equal(resolveMarkdown(repo, 'weird.md').ok, false);
});
