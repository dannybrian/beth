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

/**
 * A plan cited by its series number — "plan 174", "plans 176 and 182", "#186".
 *
 * This exists because agents talk in numbers Danny cannot map back to anything:
 * the panel shows titles, the worker says "Implement plan 176 headless stretch",
 * and connecting the two was manual. She writes the number already; nobody has to
 * change how they talk.
 *
 * ⚠️ The word `plan` (or a `#`) is REQUIRED. A bare number cannot be linked —
 * "timeout 180", "79175 tok" and "exit 2" are all in this transcript, and a
 * four-digit year is one keystroke from a plan id. Same trade as CANDIDATE above:
 * high precision, so a link is never wrong-but-plausible.
 */
const PLAN_REF = /(?<![\w#])(?:plans?\s+#?(\d{1,4})|#(\d{1,4}))\b/gi;

export function detectLinks(
  text: string,
  deps: {
    repo: string;
    lookup: (p: string) => { spoken: string } | undefined;
    /** Resolves a cited number, and MUST return nothing when it is ambiguous. */
    lookupNumber?: (n: number) => { path: string; spoken: string } | undefined;
  }
): TextLink[] {
  const out: TextLink[] = [];
  if (!text) return out;

  // Numbers first, so a message full of them still gets its paths: both loops
  // share MAX_LINKS, and a path is the more specific reference of the two.
  const taken: Array<[number, number]> = [];
  if (deps.lookupNumber) {
    for (const m of text.matchAll(PLAN_REF)) {
      const item = deps.lookupNumber(Number(m[1] ?? m[2]));
      if (!item) continue;
      out.push({
        start: m.index,
        end: m.index + m[0].length,
        path: item.path,
        kind: 'plan',
        spoken: item.spoken,
      });
      taken.push([m.index, m.index + m[0].length]);
    }
  }

  for (const m of text.matchAll(CANDIDATE)) {
    if (out.length >= MAX_LINKS) break;
    if (taken.some(([a, b]) => m.index < b && m.index + m[0].length > a)) continue;
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
  // The page splices by offset, so anything out of order renders scrambled.
  out.sort((a, b) => a.start - b.start);
  return out.slice(0, MAX_LINKS);
}
