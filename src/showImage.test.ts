// The /api/image allowlist is this function — a mistake here is not a broken
// image, it is a query string reading files off the machine. Every refusal is
// tested by geometry (a real file in the wrong place), not by string shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveImage } from './showImage.ts';

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
