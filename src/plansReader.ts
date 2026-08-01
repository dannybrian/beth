// The BUILT-IN `/plans` reader — dated markdown with YAML frontmatter.
//
// This is one reader among N, not the harness's idea of how work is stored. It
// ships built in because the convention is Danny's, not any one repo's: the repos
// he runs a director against keep plans this way, so requiring each of them to
// supply a reader would be ceremony for the 95% case. A project whose work lives
// somewhere foreign supplies its own reader instead (see workItems.ts).
//
// Written against beadgame's real corpus — 571 plans across a dozen directories —
// not against an idea of it. The surprises that shaped it are marked below.
import fs from 'node:fs';
import path from 'node:path';
import { liveRecords } from './directorRole.ts';
import { stripMarkdown, taskSpoken } from './spokenName.ts';
import type { WorkClaim, WorkItemDraft, WorkStatus, WorkTask } from './workItems.ts';

const KNOWN_STATUS: WorkStatus[] = ['idea', 'planning', 'active', 'blocked', 'shipped', 'parked', 'unknown'];

/** Directories never worth walking, whatever they contain. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'tmp', 'logs', 'releases', 'old', '.next', 'Library']);

/** Files inside a plans directory that are not plans. */
const NOT_A_PLAN = /^(INDEX|README|CONTINUE|EVENTS|ONBOARDING|TEMPLATE)\.md$/i;

/**
 * THE HARNESS IS A READER, NOT AN AUTHORITY.
 *
 * The project's own `/plans` and `/tidyrepo` skills own where plans live and
 * whether they are accurate; they scaffold, claim, tick, re-home and re-index.
 * This reader only observes. It never writes a plan file, never repairs
 * frontmatter, and never decides a plan is in the wrong place — a panel that
 * quietly disagreed with `/plans` would be a second source of truth, which is the
 * one thing this design is trying to avoid.
 *
 * So discovery DEFERS where it can: if the project publishes an index, its plan
 * paths are the authority on which directories count, and the filesystem
 * heuristic below only fills gaps (a plan written since the last re-index).
 * Content always comes from the files themselves — the index tells us WHERE to
 * look, never WHAT is currently true.
 */
function rootsFromProjectIndex(repo: string, discovered: string[]): string[] {
  const out: string[] = [];
  for (const root of discovered) {
    const file = path.join(root, 'INDEX.json');
    if (!fs.existsSync(file)) continue;
    try {
      const idx = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const p of idx.plans ?? []) {
        if (typeof p?.path !== 'string') continue;
        const dir = path.resolve(repo, path.dirname(p.path));
        if (dir.startsWith(repo) && fs.existsSync(dir)) out.push(dir);
      }
    } catch {
      /* an unreadable index is not our problem to fix — fall back to the walk */
    }
  }
  return out;
}

/**
 * SURPRISE 1: plans are not in one directory. beadgame keeps them under `plans/`,
 * `game/plans/unity/`, `game/plans/backend/`, `game/plans/superpowers/specs/` and
 * more — a dozen roots, with the bulk NOT under the top-level `plans/`. So we find
 * every directory NAMED `plans` and take everything beneath it.
 */
export function discoverRoots(repo: string, maxDepth = 4): string[] {
  const roots: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.name === 'plans') {
        roots.push(abs); // everything under it is ours; no need to descend further
        continue;
      }
      walk(abs, depth + 1);
    }
  };
  walk(repo, 0);
  return roots.sort();
}

/**
 * Minimal frontmatter parser. Deliberately not a YAML dependency: plan
 * frontmatter is flat `key: value` with the occasional `[a, b]` list, and rolling
 * ~20 lines beats taking a package (see CLAUDE.md).
 */
export function parseFrontmatter(text: string): { fm: Record<string, string | string[]>; bodyLine: number } {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return { fm: {}, bodyLine: 0 };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return { fm: {}, bodyLine: 0 };

  const fm: Record<string, string | string[]> = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2].trim();
    if (!raw || raw === 'null' || raw === '~') continue; // absent, not empty-string
    if (raw.startsWith('[')) {
      fm[m[1]] = raw
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      fm[m[1]] = raw.replace(/^["']|["']$/g, '');
    }
  }
  return { fm, bodyLine: end + 1 };
}

const str = (v: string | string[] | undefined): string | undefined =>
  typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;

/**
 * SURPRISE 2: the title is NOT in frontmatter. Every plan carries it as the first
 * H1 in the body. Falling back to the filename keeps a malformed plan visible
 * rather than silently absent from the panel.
 */
export function extractTitle(lines: string[], from: number, relPath: string): string {
  for (let i = from; i < Math.min(lines.length, from + 40); i++) {
    const m = /^#\s+(.+?)\s*$/.exec(lines[i]);
    if (m) return m[1];
  }
  return (relPath.split('/').pop() ?? relPath).replace(/\.md$/, '');
}

/**
 * Markdown checkboxes, which is how tasks are written when a plan has them.
 *
 * SURPRISE 3: fenced code blocks are everywhere in these plans, and a `- [ ]`
 * inside one is sample text, not a task. Counting it would inflate every affected
 * plan's task total with work that does not exist.
 */
export function parseTasks(lines: string[], from: number): WorkTask[] {
  const tasks: WorkTask[] = [];
  let fence: string | null = null;

  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      if (!fence) fence = f[1].slice(0, 3);
      else if (line.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    if (fence) continue;

    const m = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    // Display text is stripped too, not just the spoken form — raw `**bold**`
    // and backticks are noise in a 300px panel, and tasks are written with both.
    const text = stripMarkdown(m[3]);
    tasks.push({
      index: tasks.length,
      line: i + 1, // 1-based, for a VSCode handoff
      text,
      spoken: taskSpoken(text),
      done: m[2] !== ' ',
      depth: Math.floor(m[1].replace(/\t/g, '  ').length / 2),
    });
  }
  return tasks;
}

/**
 * SURPRISE 4: `future/` means parked. The /plans skill infers this at read time
 * and never writes it back, so a reader that does not mirror the rule surfaces
 * dozens of long-abandoned parking-lot ideas as `unknown` — straight into the panel.
 */
function inferStatus(fm: Record<string, string | string[]>, relPath: string): WorkStatus {
  const raw = str(fm.status)?.toLowerCase();
  if (raw && (KNOWN_STATUS as string[]).includes(raw)) return raw as WorkStatus;
  if (raw) return 'unknown';
  return relPath.split('/').includes('future') ? 'parked' : 'unknown';
}

export type PlansReaderOptions = {
  repo: string;
  /** Override discovery — HARNESS_PLAN_ROOTS, repo-relative, comma separated. */
  roots?: string[];
};

export function createPlansReader(opts: PlansReaderOptions) {
  const { repo } = opts;

  const roots = () => {
    if (opts.roots?.length) return opts.roots.map((r) => path.resolve(repo, r)).filter(fs.existsSync);
    const found = discoverRoots(repo);
    // Drop any root already contained in another — the walk below is recursive,
    // and re-walking a subdirectory would read those plans twice.
    const all = [...new Set([...found, ...rootsFromProjectIndex(repo, found)])].sort();
    return all.filter((r, i) => !all.some((other, j) => j !== i && r.startsWith(other + path.sep)));
  };

  const files = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(abs);
        } else if (e.name.endsWith('.md') && !NOT_A_PLAN.test(e.name)) {
          out.push(abs);
        }
      }
    };
    walk(root);
    return out;
  };

  return {
    name: 'plans',

    watchRoots(): string[] {
      // The sessions directory is watched too: a claim landing or going stale
      // changes what the panel shows without any plan file being touched.
      return [...roots(), path.join(repo, '.claude', 'sessions')].filter(fs.existsSync);
    },

    read(): WorkItemDraft[] {
      // One pass over session records per read, not per plan.
      const live = new Map<string, ReturnType<typeof liveRecords>[number]>();
      for (const r of liveRecords(repo)) if (r.plan_path) live.set(r.plan_path, r);

      const items: WorkItemDraft[] = [];
      for (const root of roots()) {
        for (const abs of files(root)) {
          let text: string;
          try {
            text = fs.readFileSync(abs, 'utf8');
          } catch {
            continue; // a file that vanished mid-walk is not an error
          }
          const rel = path.relative(repo, abs);
          const { fm, bodyLine } = parseFrontmatter(text);
          const lines = text.split('\n');

          const owner = str(fm.owner);
          const rec = live.get(rel);
          const claim: WorkClaim | null = owner
            ? {
                owner,
                // A live claim needs a fresh session record naming THIS plan —
                // a dangling `owner:` is not an implementer at work.
                live: Boolean(rec) && rec!.session_id === owner,
                sessionId: rec?.session_id,
                lastHeartbeat: rec?.last_heartbeat,
              }
            : null;

          items.push({
            path: rel,
            title: extractTitle(lines, bodyLine, rel),
            // Optional `name:` — a plan naming itself. Wins over any derived
            // name (see spokenName.ts). Absent on every plan today, which is
            // exactly why derivation has to be good on its own.
            name: str(fm.name),
            status: inferStatus(fm, rel),
            priority: str(fm.priority),
            started: str(fm.started),
            lastTouched: str(fm.last_touched),
            tags: Array.isArray(fm.tags) ? fm.tags : fm.tags ? [String(fm.tags)] : [],
            claim,
            tasks: parseTasks(lines, bodyLine),
            reader: 'plans',
          });
        }
      }
      return items;
    },
  };
}
