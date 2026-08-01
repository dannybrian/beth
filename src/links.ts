// Finding file references inside what Beth writes, so the transcript can make
// them clickable.
//
// The tempting approach is to have her emit markup. That is wrong here: she is
// frequently HEARD, and anything she writes for the page has to survive being
// read aloud. Markdown links in her prose would either be spoken as punctuation
// soup or need a second stripping pass with its own bugs.
//
// So detection happens on OUR side, after the fact, and it is deliberately
// high-precision rather than clever: a candidate only becomes a link if the
// harness can PROVE it points at something — a path in the work index, or a file
// that actually exists in the repo. Nothing is guessed, so nothing is
// wrong-but-plausible, and she carries no new burden at all.
import fs from 'node:fs';
import path from 'node:path';

export type TextLink = {
  /** Character range in the message text, so the UI can splice without re-matching. */
  start: number;
  end: number;
  /** Repo-relative path. */
  path: string;
  /** 1-based line, when the reference carried one (`src/config.ts:42`). */
  line?: number;
  kind: 'plan' | 'file';
  /** Present for plans — lets a click point Beth at it, not just open it. */
  spoken?: string;
};

/**
 * Something path-shaped: optional directories, a filename, a dotted extension of
 * letters. The extension must be alphabetic so ordinary prose ("version 1.2",
 * "up 3.5x") cannot match, and the lookbehind stops us starting mid-path.
 */
const CANDIDATE = /(?<![\w/.\-:])((?:[\w.\-]+\/)+[\w.\-]+\.[A-Za-z][A-Za-z0-9]{0,7}|[\w\-]+\.[A-Za-z][A-Za-z0-9]{0,7})(?::(\d+))?/g;

/** Never link more than this from one message — a runaway match is a bug, not a feature. */
const MAX_LINKS = 25;

export function detectLinks(
  text: string,
  deps: { repo: string; lookup: (p: string) => { spoken: string } | undefined }
): TextLink[] {
  const out: TextLink[] = [];
  if (!text) return out;

  for (const m of text.matchAll(CANDIDATE)) {
    if (out.length >= MAX_LINKS) break;
    const rel = m[1];
    const line = m[2] ? Number(m[2]) : undefined;

    // A path in the index is a plan, and carries the name she should say for it.
    const item = deps.lookup(rel);
    if (item) {
      out.push({ start: m.index, end: m.index + m[0].length, path: rel, line, kind: 'plan', spoken: item.spoken });
      continue;
    }

    // Otherwise it has to be a real file in the repo. Proving it beats guessing:
    // "e.g" and "README.md" look identical to a regex and only one is a link.
    const abs = path.resolve(deps.repo, rel);
    if (!abs.startsWith(deps.repo + path.sep)) continue; // no escaping the repo
    try {
      if (!fs.statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length, path: rel, line, kind: 'file' });
  }
  return out;
}
