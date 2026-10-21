// Images Danny pastes, drops or uploads into the composer.
//
// Two jobs, and both are fences. On the way IN: the model receives the bytes as
// an image block, and a block the API rejects is not a failed turn — it is a
// failed CONVERSATION, because every later turn re-sends the history it sits in.
// So the media type is read off the bytes rather than taken from the page (a
// mismatch is a 400), and the size is capped below the API's limit. On the way
// OUT: /api/pasted builds a response from a query parameter, so it answers only
// an id this module could have minted — the same standard as showImage.ts.
//
// Saved in the state dir rather than kept in memory: the bus replays turns as
// ids (base64 in the replay would ride to every connecting tab), and a path on
// disk is something a worker can Read when she hands the picture on.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** The API accepts exactly these. Keys are what the bytes say, never the page. */
const KINDS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
const MIME_OF: Record<string, string> = Object.fromEntries(Object.entries(KINDS).map(([m, e]) => [e, m]));

/**
 * The API's ceiling is 5 MB per image. Held under it with room to spare, since
 * the page already shrinks anything big (app.js) — reaching this means a page
 * that did not, and refusing here beats poisoning the history.
 */
export const MAX_BYTES = 3_750_000;

/** Old pastes are swept on save. Nothing in the harness references one this old. */
const KEEP_MS = 30 * 24 * 3600_000;

const ID = /^[0-9a-f]{16}\.(png|jpg|gif|webp)$/;

export function sniff(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP')
    return 'image/webp';
  return null;
}

export type Pasted = { id: string; abs: string; mime: string; data: string };

/** `data` is base64 as the page sends it — with or without a `data:` prefix. */
export function savePasted(dir: string, data: string, now = Date.now()): { ok: true; image: Pasted } | { ok: false; reason: string } {
  const b64 = String(data ?? '').replace(/^data:[^,]*,/, '');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return { ok: false, reason: 'empty image' };
  if (buf.length > MAX_BYTES) return { ok: false, reason: `image is ${(buf.length / 1e6).toFixed(1)} MB — the limit is ${MAX_BYTES / 1e6} MB` };
  const mime = sniff(buf);
  if (!mime) return { ok: false, reason: 'not a PNG, JPEG, GIF or WebP image' };
  fs.mkdirSync(dir, { recursive: true });
  sweep(dir, now);
  const id = crypto.randomBytes(8).toString('hex') + KINDS[mime];
  const abs = path.join(dir, id);
  fs.writeFileSync(abs, buf);
  // Re-encoded from the bytes, so what the model gets is exactly what was saved.
  return { ok: true, image: { id, abs, mime, data: buf.toString('base64') } };
}

export function resolvePasted(dir: string, id: string): { ok: true; abs: string; mime: string } | { ok: false; reason: string } {
  // The shape IS the allowlist: sixteen hex and a known extension cannot spell
  // a separator or a `..`, so there is no path to resolve and nothing to fence.
  if (!ID.test(id)) return { ok: false, reason: 'not a pasted image id' };
  const abs = path.join(dir, id);
  try {
    if (!fs.statSync(abs).isFile()) return { ok: false, reason: 'gone' };
  } catch {
    return { ok: false, reason: 'gone' };
  }
  return { ok: true, abs, mime: MIME_OF[path.extname(id)] };
}

function sweep(dir: string, now: number) {
  for (const f of fs.readdirSync(dir)) {
    if (!ID.test(f)) continue;
    try {
      const p = path.join(dir, f);
      if (now - fs.statSync(p).mtimeMs > KEEP_MS) fs.unlinkSync(p);
    } catch {
      // A neighbour got there first; nothing to do.
    }
  }
}
