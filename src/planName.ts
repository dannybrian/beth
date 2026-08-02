// The ONE thing in this harness that writes to a plan file.
//
// ⚠️ Read this before adding a second. The standing rule is that the harness only
// OBSERVES: the project's `/plans` and `/tidyrepo` own where plans live and
// whether they are accurate, and a panel that quietly disagreed with them would
// be a second source of truth. That rule is not repealed here.
//
// What makes this the exception rather than the first crack in it:
//
//   - `workItems.ts` already anticipated it — the `name` field exists precisely so
//     "a future rename affordance has somewhere to write to". This is that.
//   - It writes ONE key, `name:`, which is the plan naming ITSELF. Nothing else in
//     the file is touched: not the body, not the other keys, not their formatting,
//     not their order.
//   - A plan with no frontmatter is REFUSED, not repaired. Creating a frontmatter
//     block is exactly the "repair" the rule forbids, and a plan without one is
//     something `/tidyrepo` should be told about, not something a rename should
//     quietly fix on its way past.
//
// The spoken name is the half of a reference that makes pointing work, and a
// derived one is sometimes wrong in a way only Danny can see. Being unable to
// correct it from the surface where he notices it is the gap this closes.
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './plansReader.ts';

/** Long enough for a real name, short enough to stay sayable and fit the panel. */
export const MAX_NAME = 80;

export type RenameResult = { ok: true; name: string; path: string } | { ok: false; reason: string };

/**
 * One line, no control characters, no markup noise. A name is SPOKEN — it ends up
 * in Beth's mouth — so a newline or a stray backtick in it is not a formatting
 * question, it is a pronunciation one.
 */
export function cleanName(raw: string): string {
  return String(raw ?? '')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME)
    .trim();
}

/**
 * Quote only when the flat `key: value` parser would otherwise misread it.
 *
 * ⚠️ Two characters cannot be expressed AT ALL, and quoting does not save either:
 *
 *   - `"` — the parser strips surrounding quotes without unescaping anything.
 *   - `#` — it strips a trailing ` #…` as a YAML comment (the plan template ships
 *     annotated fields like `status: planning  # idea | planning | …`) and it does
 *     that BEFORE stripping quotes, so `name: "Engine v7 #2"` reads back as
 *     `Engine v7`. Wrapping it makes it worse, not better.
 *
 * Refusing beats writing a file that reads back as a different name. The
 * round-trip check below is the backstop; these two get a reason he can act on.
 */
function yamlValue(name: string): { value: string } | { reason: string } {
  if (name.includes('"')) return { reason: 'a name cannot contain a double quote' };
  if (name.includes('#')) return { reason: 'a name cannot contain # — the frontmatter parser reads it as a comment' };
  return { value: /:\s|^['"]|['"]$/.test(name) ? `"${name}"` : name };
}

export function setPlanName(repo: string, rel: string, raw: string): RenameResult {
  const name = cleanName(raw);
  if (!name) return { ok: false, reason: 'a name cannot be empty' };
  const quoted = yamlValue(name);
  if ('reason' in quoted) return { ok: false, reason: quoted.reason };
  const value = quoted.value;

  // ⚠️ This WRITES, so the path is checked as a path and not merely used as one.
  // `..` in a repo-relative path from a page is the difference between renaming a
  // plan and writing into someone's home directory.
  const abs = path.resolve(repo, rel);
  if (!abs.startsWith(path.resolve(repo) + path.sep)) return { ok: false, reason: 'outside the repo' };
  if (!abs.endsWith('.md')) return { ok: false, reason: 'not a markdown file' };
  if (!fs.existsSync(abs)) return { ok: false, reason: 'no such plan' };

  let text: string;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return { ok: false, reason: `unreadable — ${String(e)}` };
  }

  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { ok: false, reason: 'this plan has no frontmatter — adding one is /tidyrepo\'s job, not the panel\'s' };
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return { ok: false, reason: 'frontmatter is not closed' };

  // Replace in place when the key is already there, so the author's field order
  // survives; otherwise it goes first, where a name belongs.
  const at = lines.findIndex((l, i) => i > 0 && i < end && /^name:\s/.test(l));
  if (at >= 0) lines[at] = `name: ${value}`;
  else lines.splice(1, 0, `name: ${value}`);

  const next = lines.join('\n');
  // Prove it reads back as what was asked for BEFORE the file changes. The writer
  // and the reader disagreeing is the failure this whole module has to not have.
  const { fm } = parseFrontmatter(next);
  if (fm.name !== name) return { ok: false, reason: `that name would not read back correctly (got ${JSON.stringify(fm.name)})` };

  try {
    fs.writeFileSync(abs, next);
  } catch (e) {
    return { ok: false, reason: `could not write — ${String(e)}` };
  }
  return { ok: true, name, path: rel };
}
