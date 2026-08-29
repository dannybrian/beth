// Proving an image path before anything serves or shows it.
//
// Same standard as links.ts: a path only becomes something the page acts on if
// the harness can PROVE it names a real image file inside the bound repo.
// /api/image builds a response from a query parameter, and the loopback bind is
// not a reason to let a URL name any file on the machine — the repo boundary
// plus this extension list is the whole allowlist. (The work index cannot play
// the allowlist role it plays for /api/github: images are not work items.)
import fs from 'node:fs';
import path from 'node:path';

/** What an <img> can render, and nothing executable. Keys are lowercased extensions. */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

export type ImageResolution = { ok: true; abs: string; mime: string } | { ok: false; reason: string };

export function resolveImage(repo: string, rel: string): ImageResolution {
  if (!rel) return { ok: false, reason: 'no path' };
  const mime = IMAGE_MIME[path.extname(rel).toLowerCase()];
  if (!mime) return { ok: false, reason: `not an image: ${rel}` };
  const abs = path.resolve(repo, rel);
  // The same fence links.ts builds: resolve first, then require the result to
  // still be inside the repo — `..` and absolute paths both die here, by
  // geometry rather than by pattern-matching the string.
  if (!abs.startsWith(repo + path.sep)) return { ok: false, reason: 'outside the repo' };
  try {
    if (!fs.statSync(abs).isFile()) return { ok: false, reason: `not a file: ${rel}` };
  } catch {
    return { ok: false, reason: `no such file: ${rel}` };
  }
  return { ok: true, abs, mime };
}
