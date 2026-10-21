import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { savePasted, resolvePasted, sniff, MAX_BYTES } from './pasted.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pasted-'));

test('the media type comes from the bytes — a mislabelled image would poison the history', () => {
  assert.equal(sniff(PNG), 'image/png');
  assert.equal(sniff(JPEG), 'image/jpeg');
  assert.equal(sniff(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(sniff(WEBP), 'image/webp');
  // SVG is an image to a browser and not to the API.
  assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
});

test('a saved paste round-trips, with or without a data: prefix', () => {
  const dir = tmp();
  for (const data of [PNG.toString('base64'), `data:image/jpeg;base64,${PNG.toString('base64')}`]) {
    const r = savePasted(dir, data);
    assert.ok(r.ok);
    // The page's claimed type is ignored: these bytes are a PNG.
    assert.equal(r.image.mime, 'image/png');
    assert.match(r.image.id, /\.png$/);
    assert.deepEqual(fs.readFileSync(r.image.abs), PNG);
    const back = resolvePasted(dir, r.image.id);
    assert.ok(back.ok);
    assert.equal(back.mime, 'image/png');
  }
});

test('refuses what the API would refuse', () => {
  const dir = tmp();
  assert.equal(savePasted(dir, '').ok, false);
  assert.equal(savePasted(dir, Buffer.from('hello').toString('base64')).ok, false);
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_BYTES)]);
  const r = savePasted(dir, big.toString('base64'));
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.reason, /MB/);
  // Nothing refused was written.
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('/api/pasted answers only an id this module could have minted', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(path.dirname(dir), 'secret.png'), PNG);
  for (const id of ['', '../secret.png', 'secret.png', '0123456789abcdef.svg', '0123456789abcdef.png/../x', '/etc/passwd']) {
    assert.equal(resolvePasted(dir, id).ok, false, id);
  }
  // Well-formed but never saved.
  assert.equal(resolvePasted(dir, '0123456789abcdef.png').ok, false);
});

test('old pastes are swept on the next save, fresh ones kept', () => {
  const dir = tmp();
  const old = savePasted(dir, PNG.toString('base64'));
  assert.ok(old.ok);
  const month = new Date(Date.now() - 31 * 24 * 3600_000);
  fs.utimesSync(old.image.abs, month, month);
  const kept = savePasted(dir, PNG.toString('base64'));
  assert.ok(kept.ok);
  savePasted(dir, PNG.toString('base64'));
  assert.equal(fs.existsSync(old.image.abs), false);
  assert.equal(fs.existsSync(kept.image.abs), true);
});
