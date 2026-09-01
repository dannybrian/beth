#!/usr/bin/env node
// /plans skill — multi-agent work tracker.
// Vendored from beadgame by /director-skills (snapshot 2026-08-06); this repo owns it now.
// See ./SKILL.md and plans/README.md.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import os from 'node:os';
import { sessionId, claimDecision, releaseDecision, ownsPlan, normalizePlanPath, lifecycleGuard } from './lib/session.mjs';
import { trailerDecision } from './lib/trailer.mjs';
import {
  normalizeShaList, filterExcludedCommits, mergeIncludedCommits, parseShaListValue,
  SHA_LIST_KEYS, trailerGrepPattern, TRAILER_LINE_RE,
} from './lib/commits.mjs';

// ─── Constants ─────────────────────────────────────────────────────────────

// `awaiting-eyes` is LIVE, not terminal: every mechanical gate passed and only a human
// read is owed. It must be settable and it must print on the board — a status the plans
// README documents but this CLI rejects is two sources of truth, which is the split this
// whole file exists to prevent.
const STATUSES = ['idea', 'planning', 'active', 'awaiting-eyes', 'blocked', 'shipped', 'parked', 'review'];
const STALE_HOURS = 4;
const PLAN_TREES = ['plans']; // relative to repo root — add more trees if plans live in several places
const STATUS_ORDER = { active: 0, 'awaiting-eyes': 1, blocked: 2, planning: 3, idea: 4, shipped: 5, parked: 6, review: 7, unknown: 8 };

// ─── Repo root ─────────────────────────────────────────────────────────────

function findRepoRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'CLAUDE.md')) && fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  // Fallback: assume we're being called by absolute path; derive from script location
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  // .claude/skills/plans → repo root is 3 up
  return path.resolve(scriptDir, '..', '..', '..');
}

const REPO_ROOT = findRepoRoot();
const SESSIONS_DIR = path.join(REPO_ROOT, '.claude', 'sessions');

// Everything below hangs off PLAN_TREES[0], so moving plans out of `plans/` really is
// the one-line edit the docs promise. It used to be four hardcoded `plans/` joins, and
// a repo that followed the instruction got a CLI that walked the right tree, then died
// on `new` and wrote its index into a directory that did not exist.
const PRIMARY_TREE = PLAN_TREES[0];
const TEMPLATE_PATH = path.join(REPO_ROOT, PRIMARY_TREE, 'TEMPLATE.md');
const INDEX_MD = path.join(REPO_ROOT, PRIMARY_TREE, 'INDEX.md');
const INDEX_JSON = path.join(REPO_ROOT, PRIMARY_TREE, 'INDEX.json');

// ─── YAML helpers (small subset: scalars, null, inline arrays, dates) ─────

function parseYamlValue(raw) {
  const v = raw.trim();
  if (v === '' || v === '~' || v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  // Inline array: [a, b, c] or []
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map(s => parseYamlValue(s));
  }
  // Strip surrounding quotes
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function stringifyYamlValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return '[' + v.map(stringifyYamlValue).join(', ') + ']';
  // Strings — quote if contains special chars
  const s = String(v);
  if (/^[\w./:-]+$/.test(s) || /^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  return JSON.stringify(s);
}

// ─── Frontmatter ──────────────────────────────────────────────────────────

function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { meta: null, body: text, raw: null };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end === -1) return { meta: null, body: text, raw: null };
  const fmLines = lines.slice(1, end);
  const meta = {};
  const order = [];
  for (const line of fmLines) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    // Sha lists bypass the generic scalar path: it coerces /^-?\d+$/ to a
    // number, which silently mangles an all-digit sha with a leading zero
    // (0049719 → 49719) and breaks the exclusion that names it.
    meta[key] = SHA_LIST_KEYS.has(key) ? parseShaListValue(val) : parseYamlValue(val);
    order.push(key);
  }
  meta.__order = order;
  const body = lines.slice(end + 1).join('\n');
  return { meta, body, raw: lines.slice(0, end + 1).join('\n') };
}

function stringifyFrontmatter(meta) {
  const order = meta.__order || Object.keys(meta);
  const seen = new Set();
  const out = ['---'];
  for (const k of order) {
    if (k === '__order') continue;
    if (k in meta) {
      out.push(`${k}: ${stringifyYamlValue(meta[k])}`);
      seen.add(k);
    }
  }
  for (const k of Object.keys(meta)) {
    if (k === '__order' || seen.has(k)) continue;
    out.push(`${k}: ${stringifyYamlValue(meta[k])}`);
  }
  out.push('---');
  return out.join('\n');
}

function readPlan(absPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  return parseFrontmatter(text);
}

function writePlanFrontmatter(absPath, updates) {
  const text = fs.readFileSync(absPath, 'utf8');
  const parsed = parseFrontmatter(text);
  if (!parsed.meta) {
    // No frontmatter — prepend a fresh block with the updates
    const meta = { ...defaultFrontmatter(), ...updates };
    meta.__order = Object.keys(defaultFrontmatter());
    const fm = stringifyFrontmatter(meta);
    fs.writeFileSync(absPath, fm + '\n\n' + text);
    return;
  }
  const { meta, body } = parsed;
  for (const [k, v] of Object.entries(updates)) {
    meta[k] = v;
    if (!meta.__order.includes(k)) meta.__order.push(k);
  }
  const fm = stringifyFrontmatter(meta);
  fs.writeFileSync(absPath, fm + '\n' + body);
}

function defaultFrontmatter() {
  return {
    status: 'planning',
    owner: null,
    branch: 'main',
    worktree: null,
    started: null,
    last_touched: today(),
    priority: 'P2',
    tags: [],
    depends_on: [],
  };
}

// ─── Session ──────────────────────────────────────────────────────────────

function sessionPath(sid = sessionId()) {
  return path.join(SESSIONS_DIR, `${sid}.json`);
}

function readSession(sid = sessionId()) {
  const p = sessionPath(sid);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeSession(record) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const p = sessionPath(record.session_id);
  fs.writeFileSync(p, JSON.stringify(record, null, 2) + '\n');
}

function deleteSession(sid = sessionId()) {
  const p = sessionPath(sid);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function listSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

// ─── Plan discovery ───────────────────────────────────────────────────────

function listPlans() {
  const plans = [];
  for (const tree of PLAN_TREES) {
    walk(path.join(REPO_ROOT, tree), plans, tree);
  }
  return plans;
}

function walk(dir, out, treeName) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      walk(full, out, treeName);
    } else if (ent.isFile() && ent.name.endsWith('.md')) {
      // Skip generated/standard files
      if (ent.name === 'INDEX.md' || ent.name === 'README.md' || ent.name === 'TEMPLATE.md') continue;
      out.push({ absPath: full, relPath: path.relative(REPO_ROOT, full), tree: treeName });
    }
  }
}

// Per-SERIES plan counter. Per CLAUDE.md, the numbered series (backend, unity,
// rules-engine, …) each carry their OWN sequence — the number preserves phase
// ordering within that series — so the counter is scoped to the target directory,
// NOT repo-wide. It collects every NN already present under `scopeDir` (recursing,
// matching any digit run so it climbs past 99) and returns one past the max.
//
// Reading the actual numbers (vs the old `existing.length + 1`, which COUNTED
// files — a dir of 99 files yielded "100", re-minting an in-use number) is what
// makes it collision-safe across NON-simultaneous creation: a number already on
// disk can never be the max+1. The one residual gap is two sessions allocating in
// the same sub-second window (both read the same max); cmdNew's exclusive-create
// write narrows that, and `taken` lets the caller skip a number that appeared
// between the scan and the write. Returns both so the caller can do that check.
function seriesNumbersIn(scopeDir) {
  const taken = new Set();
  const out = [];
  walk(scopeDir, out, scopeDir);
  for (const plan of out) {
    const m = path.basename(plan.relPath).match(/^\d{4}-\d{2}-\d{2}-(\d+)-/);
    if (m) taken.add(parseInt(m[1], 10));
  }
  return taken;
}

function nextSeriesNumber(scopeDir) {
  const taken = seriesNumbersIn(scopeDir);
  let max = 0;
  for (const n of taken) if (n > max) max = n;
  // Skip anything already on disk (defensive — max+1 is already free, but a
  // different-slug plan minted by a parallel session moments ago would show here).
  let num = max + 1;
  while (taken.has(num)) num++;
  return num;
}

function summarize(plan) {
  const { meta, body } = readPlan(plan.absPath);
  const title = extractTitle(body) || path.basename(plan.absPath, '.md');
  const summary = extractContextSummary(body);
  const fm = meta || {};
  // Path-based fallback: ideas under future/ dirs don't carry frontmatter
  // (the park skill writes plain markdown). Treat them as parked rather than
  // unknown so the dashboard's Parked group surfaces them.
  const inFuture = plan.relPath.split('/').includes('future');
  const status = fm.status || (inFuture ? 'parked' : 'unknown');
  return {
    path: plan.relPath,
    title,
    summary,
    status,
    owner: fm.owner || null,
    branch: fm.branch || null,
    worktree: fm.worktree || null,
    started: fm.started || null,
    last_touched: fm.last_touched || null,
    priority: fm.priority || null,
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    depends_on: Array.isArray(fm.depends_on) ? fm.depends_on : [],
    // normalizeShaList, not a bare Array.isArray pass: our YAML subset parses an
    // all-digit short sha (44002735) as a NUMBER, which then landed in
    // INDEX.json as a number no consumer can use as a sha.
    // (commits_exclude and commits_include both stay out of INDEX on purpose —
    // each is an authoring input that surfaces only via the merged/filtered
    // field above, and the plan file is its one home.)
    commits: normalizeShaList(fm.commits),
    has_frontmatter: !!meta,
  };
}

function extractTitle(body) {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function extractContextSummary(body) {
  // First paragraph after a "## Context" heading
  const m = body.match(/^##\s+Context\s*\n+([^\n][^\n]*(?:\n[^\n#][^\n]*)*)/m);
  if (!m) return null;
  return m[1].trim().replace(/\s+/g, ' ').slice(0, 240);
}

// ─── Utilities ────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function gitBranch() {
  try { return execSync('git -C ' + JSON.stringify(REPO_ROOT) + ' branch --show-current', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}

function relTime(iso) {
  if (!iso) return '?';
  const t = new Date(iso).getTime();
  const dt = (Date.now() - t) / 1000;
  if (dt < 60) return `${Math.floor(dt)}s ago`;
  if (dt < 3600) return `${Math.floor(dt/60)}m ago`;
  if (dt < 86400) return `${Math.floor(dt/3600)}h ago`;
  return `${Math.floor(dt/86400)}d ago`;
}

function isStale(record) {
  if (!record.last_heartbeat) return true;
  const dt = (Date.now() - new Date(record.last_heartbeat).getTime()) / 3600000;
  return dt > STALE_HOURS;
}

function resolveRel(p) {
  // normalizePlanPath makes the result an equality KEY, not just a label:
  // claimDecision compares a session record's plan_path against the plan being
  // claimed, so 'plans/x.md' and './plans/x.md' must resolve to one string or a
  // live owner reachable only via a differently-spelled path looks "moved on".
  if (path.isAbsolute(p)) return normalizePlanPath(path.relative(REPO_ROOT, p));
  return normalizePlanPath(p);
}

function abs(p) {
  return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
}

// ─── Commands ─────────────────────────────────────────────────────────────

function parseFilters(args) {
  const filters = { tag: null, status: null, scope: null, all: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--all') filters.all = true;
    else if (a === '--tag') filters.tag = args[++i];
    else if (a.startsWith('--tag=')) filters.tag = a.slice(6);
    else if (a === '--status') filters.status = args[++i];
    else if (a.startsWith('--status=')) filters.status = a.slice(9);
    else if (a === '--scope') filters.scope = args[++i];
    else if (a.startsWith('--scope=')) filters.scope = a.slice(8);
  }
  return filters;
}

function applyFilters(plans, filters) {
  return plans.filter(p => {
    if (filters.tag && !p.tags.includes(filters.tag)) return false;
    if (filters.status && p.status !== filters.status) return false;
    if (filters.scope && !p.path.startsWith(filters.scope.replace(/\/$/, '') + '/')) return false;
    return true;
  });
}

function cmdBoard(args = []) {
  const filters = parseFilters(args);
  const sessions = listSessions();
  const allPlans = listPlans().map(summarize);
  const filtered = applyFilters(allPlans, filters);
  const byPath = new Map(allPlans.map(p => [p.path, p]));

  const filterDesc = [
    filters.tag && `tag=${filters.tag}`,
    filters.status && `status=${filters.status}`,
    filters.scope && `scope=${filters.scope}`,
    filters.all && 'all',
  ].filter(Boolean).join(' ');
  if (filterDesc) console.log(`(filtered: ${filterDesc})\n`);

  console.log('━━━ Active Now ━━━');
  const visibleSessions = filters.tag || filters.status || filters.scope
    ? sessions.filter(s => filtered.some(p => p.path === s.plan_path))
    : sessions;
  if (visibleSessions.length === 0) {
    console.log('  (no claims)');
  } else {
    visibleSessions.sort((a, b) => (b.last_heartbeat || '').localeCompare(a.last_heartbeat || ''));
    for (const s of visibleSessions) {
      const plan = byPath.get(s.plan_path);
      const title = plan ? plan.title : path.basename(s.plan_path, '.md');
      const stale = isStale(s) ? ' [stale]' : '';
      console.log(`  ${title}${stale}`);
      console.log(`    plan: ${s.plan_path}`);
      console.log(`    branch: ${s.branch || '?'}   terminal: ${s.session_id}   heartbeat: ${relTime(s.last_heartbeat)}`);
    }
  }

  const groups = new Map();
  for (const p of filtered) {
    if (!p.has_frontmatter) continue;
    const showShipped = filters.all || filters.status === 'shipped' || filters.status === 'parked' || filters.status === 'idea' || filters.status === 'review';
    if (!showShipped && (p.status === 'shipped' || p.status === 'parked' || p.status === 'idea' || p.status === 'review' || p.status === 'unknown')) continue;
    if (!groups.has(p.status)) groups.set(p.status, []);
    groups.get(p.status).push(p);
  }

  const statusOrder = filters.all
    ? ['active', 'awaiting-eyes', 'blocked', 'planning', 'idea', 'shipped', 'parked', 'review']
    : ['active', 'awaiting-eyes', 'blocked', 'planning'];
  for (const status of statusOrder) {
    const list = groups.get(status);
    if (!list || list.length === 0) continue;
    console.log(`\n━━━ ${status.toUpperCase()} ━━━`);
    list.sort((a, b) => (b.last_touched || '').localeCompare(a.last_touched || ''));
    for (const p of list) {
      const owner = p.owner ? ` (${p.owner})` : '';
      const pri = p.priority ? ` [${p.priority}]` : '';
      const tags = p.tags.length ? ` ${p.tags.map(t => '#' + t).join(' ')}` : '';
      console.log(`  ${p.title}${pri}${owner}${tags}`);
      console.log(`    ${p.path} — touched ${p.last_touched || '?'}`);
    }
  }

  const legacyCount = allPlans.filter(p => !p.has_frontmatter).length;
  if (!filterDesc && legacyCount > 0) {
    console.log(`\n(${legacyCount} legacy plans without frontmatter — see plans/INDEX.md)`);
  }
}

function cmdGraph(args = []) {
  const filters = parseFilters(args);
  const plans = applyFilters(listPlans().map(summarize), filters)
    .filter(p => p.has_frontmatter);
  const withDeps = plans.filter(p => p.depends_on.length > 0);

  if (withDeps.length === 0) {
    console.log('No plans with depends_on declared.');
    if (!filters.tag && !filters.status) {
      console.log('Add `depends_on: [other-plan.md]` to a plan\'s frontmatter to wire dependencies.');
    }
    return;
  }

  const byBasename = new Map();
  for (const p of plans) byBasename.set(path.basename(p.path), p);

  // Identify depended-upon plans (referenced by anyone's depends_on)
  const dependedUpon = new Set();
  for (const p of withDeps) for (const d of p.depends_on) dependedUpon.add(d);

  // Roots: plans WITH depends_on that nothing else depends on
  const roots = withDeps.filter(p => !dependedUpon.has(path.basename(p.path)));
  const display = roots.length > 0 ? roots : withDeps;

  for (const root of display) {
    renderDepTree(root, byBasename, '', new Set());
    console.log('');
  }
}

function renderDepTree(plan, byBasename, prefix, visited) {
  const label = `${plan.title} [${plan.status}]`;
  console.log(prefix + label);
  if (visited.has(plan.path)) {
    console.log(prefix + '  (cycle)');
    return;
  }
  visited.add(plan.path);
  const deps = plan.depends_on || [];
  for (let i = 0; i < deps.length; i++) {
    const isLast = i === deps.length - 1;
    const branch = isLast ? '└── ' : '├── ';
    const nextPrefix = prefix + (isLast ? '    ' : '│   ');
    const dep = byBasename.get(deps[i]);
    if (dep) {
      console.log(prefix + branch + `${dep.title} [${dep.status}]`);
      // Recurse into dep's dependencies
      const subDeps = dep.depends_on || [];
      for (let j = 0; j < subDeps.length; j++) {
        const subIsLast = j === subDeps.length - 1;
        const subBranch = subIsLast ? '└── ' : '├── ';
        const subNext = nextPrefix + (subIsLast ? '    ' : '│   ');
        const subDep = byBasename.get(subDeps[j]);
        if (subDep) {
          renderDepTree(subDep, byBasename, nextPrefix + subBranch.replace(/[├└]── /, ''), new Set(visited));
        } else {
          console.log(nextPrefix + subBranch + `${subDeps[j]} (missing)`);
        }
      }
    } else {
      console.log(prefix + branch + `${deps[i]} (missing)`);
    }
  }
}

function cmdResume(args = []) {
  const planPathArg = args.find(a => !a.startsWith('-'));
  const sessions = listSessions();
  const targets = planPathArg
    ? sessions.filter(s => s.plan_path === resolveRel(planPathArg))
    : sessions;

  if (targets.length === 0) {
    console.log(planPathArg
      ? `No active claim for: ${planPathArg}`
      : 'No active claims to resume.');
    return;
  }

  const allPlans = listPlans().map(summarize);
  const byPath = new Map(allPlans.map(p => [p.path, p]));

  for (const s of targets) {
    const plan = byPath.get(s.plan_path);
    const title = plan ? plan.title : path.basename(s.plan_path, '.md');
    const stale = isStale(s) ? ' [stale]' : '';
    console.log(`# ${title}${stale}`);
    console.log(`#   plan: ${s.plan_path}`);
    console.log(`#   branch: ${s.branch || '?'}   heartbeat: ${relTime(s.last_heartbeat)}`);
    if (s.claude_session_id) {
      const cdPart = s.cwd && s.cwd !== process.cwd() ? `cd ${JSON.stringify(s.cwd)} && ` : '';
      console.log(`${cdPart}claude --resume ${s.claude_session_id}`);
    } else {
      console.log(`#   (no claude_session_id captured — re-claim or tick from inside that session to backfill)`);
    }
    console.log('');
  }
}

function cmdPrune(args = []) {
  const dryRun = args.includes('--dry-run');
  const sessions = listSessions();
  const stale = sessions.filter(isStale);
  if (stale.length === 0) {
    console.log('No stale claims.');
    return;
  }
  for (const s of stale) {
    console.log(`${dryRun ? 'would prune' : 'pruning'}: ${s.session_id} (${s.plan_path}, heartbeat ${relTime(s.last_heartbeat)})`);
    if (dryRun) continue;
    // Clear owner on plan if it still matches
    const absPath = abs(s.plan_path);
    if (fs.existsSync(absPath)) {
      const { meta } = readPlan(absPath);
      if (meta && meta.owner === s.session_id) {
        writePlanFrontmatter(absPath, { owner: null });
      }
    }
    deleteSession(s.session_id);
  }
}

function cmdNew(args) {
  const slug = args[0];
  if (!slug) die('Usage: new <slug> [--scope <path>] [--series]');
  const scopeIdx = args.indexOf('--scope');
  const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : PRIMARY_TREE;
  const series = args.includes('--series');

  if (!fs.existsSync(TEMPLATE_PATH)) die(`Missing template: ${TEMPLATE_PATH}`);
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8').replace(/TODAY/g, today());

  const dir = path.join(REPO_ROOT, scope);
  if (!fs.existsSync(dir)) die(`Scope dir not found: ${scope}`);

  let filename;
  if (series) {
    // Per-series counter: next number = max NN within THIS scope dir + 1 (CLAUDE.md
    // keeps backend / unity / rules-engine on independent sequences).
    const nextNum = nextSeriesNumber(dir);
    filename = `${today()}-${nextNum}-${slug}.md`;
  } else {
    filename = `${today()}-${slug}.md`;
  }

  const dest = path.join(dir, filename);
  // Exclusive create ('wx'): fails atomically if the path already exists, closing
  // the existsSync→write TOCTOU gap when two sessions scaffold the same filename.
  try {
    fs.writeFileSync(dest, template, { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') die(`Already exists: ${dest}`);
    throw e;
  }
  console.log(path.relative(REPO_ROOT, dest));
}

/**
 * Gate every WRITING lifecycle op (claim / status / release) on having a session
 * id that can actually identify this terminal. Refuses under a `fallback-` id
 * unless --force; see lifecycleGuard for why warning wasn't enough.
 */
function requireUsableSession(sid, force) {
  const guard = lifecycleGuard({ sid, force });
  if (!guard.allow) die(guard.message);
  if (guard.message) console.warn(guard.message);
}

function cmdClaim(args) {
  const planPath = args[0];
  if (!planPath) die('Usage: claim <plan-path>');
  const rel = resolveRel(planPath);
  const absPath = abs(rel);
  if (!fs.existsSync(absPath)) die(`Plan not found: ${rel}`);

  const force = args.includes('--force');
  const sid = sessionId();
  requireUsableSession(sid, force);
  const { meta: existing } = readPlan(absPath);
  const ownerRecord = existing?.owner ? readSession(existing.owner) : null;
  const decision = claimDecision({
    currentOwner: existing?.owner ?? null,
    claimant: sid,
    ownerLastHeartbeat: ownerRecord?.last_heartbeat ?? null,
    ownerPlanPath: ownerRecord?.plan_path ?? null,
    planPath: rel,
    staleHours: STALE_HOURS,
    force,
  });
  if (!decision.allow) {
    die(`${rel} is claimed by a live session (${decision.currentOwner}). ` +
        `Re-run with --force to take it, or pick another plan.`);
  }
  if (decision.reason === 'forced') {
    console.warn(`WARNING: taking ${rel} from live session ${decision.currentOwner}`);
  }
  const record = {
    session_id: sid,
    plan_path: rel,
    branch: gitBranch(),
    cwd: process.cwd(),
    terminal: process.env.TERM_SESSION_ID || process.env.ITERM_SESSION_ID || null,
    claude_session_id: process.env.CLAUDE_CODE_SESSION_ID || null,
    claimed_at: nowIso(),
    last_heartbeat: nowIso(),
  };
  writeSession(record);

  const updates = { owner: sid, last_touched: today() };
  // If status is null/idea/planning and we're claiming, bump to active + set started
  const meta = existing;
  if (!meta || !meta.status || meta.status === 'idea' || meta.status === 'planning') {
    updates.status = 'active';
    if (!meta || !meta.started) updates.started = today();
  }
  if (record.branch) updates.branch = record.branch;
  writePlanFrontmatter(absPath, updates);

  // Refresh INDEX so the dashboard sees the new owner/status without waiting
  // for an explicit `index` run. Skip the slow per-plan git-grep pass — the
  // commits frontmatter doesn't change just because someone claimed a plan.
  regenerateIndex({ syncCommits: false });

  console.log(`claimed ${rel} as ${sid}`);
}

function cmdTick(args = []) {
  const quiet = args.includes('--quiet') || args.includes('-q');
  const rec = readSession();
  if (!rec) {
    if (quiet) return;
    die('No claim in this session. Run: claim <plan-path>');
  }
  rec.last_heartbeat = nowIso();
  // Backfill claude_session_id on existing records that pre-date the field.
  if (!rec.claude_session_id && process.env.CLAUDE_CODE_SESSION_ID) {
    rec.claude_session_id = process.env.CLAUDE_CODE_SESSION_ID;
  }
  writeSession(rec);
  const absPath = abs(rec.plan_path);
  if (fs.existsSync(absPath)) {
    const { meta: cur } = readPlan(absPath);
    if (ownsPlan(cur?.owner ?? null, rec.session_id)) {
      writePlanFrontmatter(absPath, { last_touched: today() });
    }
  }
  if (!quiet) console.log(`ticked ${rec.plan_path}`);
}

function cmdStatus(args) {
  const state = args[0];
  if (!STATUSES.includes(state)) die(`status must be one of: ${STATUSES.join(', ')}`);
  requireUsableSession(sessionId(), args.includes('--force'));
  const rec = readSession();
  if (!rec) die('No claim in this session. Run: claim <plan-path>');
  const { meta: cur } = readPlan(abs(rec.plan_path));
  if (!ownsPlan(cur?.owner ?? null, rec.session_id)) {
    die(`${rec.plan_path} is no longer ours (owner: ${cur?.owner ?? 'none'}). ` +
        `Re-claim it first if that is wrong.`);
  }
  const updates = { status: state, last_touched: today() };
  if (state === 'active' && !cur?.started) updates.started = today();
  writePlanFrontmatter(abs(rec.plan_path), updates);
  rec.last_heartbeat = nowIso();
  writeSession(rec);
  regenerateIndex({ syncCommits: false });
  console.log(`${rec.plan_path} → ${state}`);
}

function cmdRelease(args = []) {
  requireUsableSession(sessionId(), args.includes('--force'));
  const rec = readSession();
  if (!rec) { console.log('no claim to release'); return; }
  const absPath = abs(rec.plan_path);
  if (fs.existsSync(absPath)) {
    const { meta } = readPlan(absPath);
    const decision = releaseDecision({
      currentOwner: meta?.owner ?? null,
      claimant: rec.session_id,
    });
    if (decision.clearOwner) {
      writePlanFrontmatter(absPath, { owner: null });
    } else if (decision.reason === 'not-owner') {
      // Someone else claimed this plan after us. Dropping our own record is right;
      // clearing THEIR ownership would be corruption.
      console.warn(`note: ${rec.plan_path} is now owned by ${meta.owner} — ` +
                   `leaving its owner untouched`);
    }
  }
  deleteSession();
  regenerateIndex({ syncCommits: false });
  console.log(`released ${rec.plan_path}`);
}

/**
 * Write plans/INDEX.{md,json} from the current state of plan files.
 *
 * Options:
 *   syncCommits: when true, run syncCommitsForPlan for every plan first
 *                (slow — one git-grep per plan, ~1s for 240 plans). When false,
 *                trust the existing `commits:` frontmatter — fast (~150ms).
 *
 * Returns the per-status counts (for callers that want to log).
 */
function regenerateIndex({ syncCommits = true } = {}) {
  if (syncCommits) {
    for (const p of listPlans()) {
      syncCommitsForPlan(p.absPath, p.relPath);
    }
  }
  const plans = listPlans().map(summarize);
  plans.sort((a, b) => {
    const sa = STATUS_ORDER[a.status] ?? 99;
    const sb = STATUS_ORDER[b.status] ?? 99;
    if (sa !== sb) return sa - sb;
    return (b.last_touched || '').localeCompare(a.last_touched || '');
  });

  fs.writeFileSync(INDEX_JSON, JSON.stringify({
    generated: nowIso(),
    plan_count: plans.length,
    plans,
  }, null, 2) + '\n');

  // Markdown
  const groups = new Map();
  for (const p of plans) {
    if (!groups.has(p.status)) groups.set(p.status, []);
    groups.get(p.status).push(p);
  }

  const md = [];
  md.push('# Plan Index');
  md.push('');
  md.push(`_Generated ${nowIso()} · ${plans.length} plans_`);
  md.push('');
  md.push('| Status | Count |');
  md.push('|---|---|');
  for (const status of ['active', 'blocked', 'planning', 'idea', 'shipped', 'parked', 'review', 'unknown']) {
    const list = groups.get(status);
    if (list) md.push(`| ${status} | ${list.length} |`);
  }
  md.push('');

  for (const status of ['active', 'blocked', 'planning', 'idea', 'shipped', 'parked', 'review', 'unknown']) {
    const list = groups.get(status);
    if (!list || list.length === 0) continue;
    md.push(`## ${status} (${list.length})`);
    md.push('');
    for (const p of list) {
      const tags = p.tags.length ? ` · _${p.tags.join(', ')}_` : '';
      const pri = p.priority ? ` · **${p.priority}**` : '';
      const touched = p.last_touched ? ` · ${p.last_touched}` : '';
      const owner = p.owner ? ` · owner: \`${p.owner}\`` : '';
      const commits = p.commits.length ? ` · ${p.commits.length} commit${p.commits.length === 1 ? '' : 's'}` : '';
      md.push(`### [${p.title}](../${p.path})`);
      md.push(`\`${p.path}\`${pri}${touched}${tags}${commits}${owner}`);
      md.push('');
      if (p.summary) md.push(`> ${p.summary}`);
      else if (!p.has_frontmatter) md.push(`> _(legacy plan — no frontmatter)_`);
      else md.push(`> _(no Context section)_`);
      md.push('');
    }
  }

  fs.writeFileSync(INDEX_MD, md.join('\n'));

  const counts = {};
  for (const status of ['active', 'blocked', 'planning', 'idea', 'shipped', 'parked', 'review', 'unknown']) {
    const list = groups.get(status);
    if (list) counts[status] = list.length;
  }
  return { plans, counts };
}

function cmdIndex() {
  const { plans, counts } = regenerateIndex({ syncCommits: true });
  console.log(`wrote ${path.relative(REPO_ROOT, INDEX_MD)} and ${path.relative(REPO_ROOT, INDEX_JSON)}`);
  console.log(`  ${plans.length} plans indexed`);
  for (const status of Object.keys(counts)) {
    console.log(`  ${status}: ${counts[status]}`);
  }
}

// ─── Commit linkage ───────────────────────────────────────────────────────

const TRAILER_PREFIX = 'Plan: ';

/**
 * Read a plan's hand-authored `commits_exclude:` list — the shas whose trailers
 * are known to be wrong. See lib/commits.mjs for why this exists.
 */
function excludedShasForPlan(planRelPath) {
  const absPath = abs(planRelPath);
  if (!fs.existsSync(absPath)) return [];
  const { meta } = readPlan(absPath);
  return normalizeShaList(meta?.commits_exclude);
}

/**
 * Read a plan's hand-authored `commits_include:` list — shas that honestly
 * belong to this plan's history but whose trailer (if any) can never say so:
 * either it names another plan, or the commit predates the trailer hook
 * entirely. See lib/commits.mjs for the merge itself and why appended-order
 * (not date-order) is the deliberate, simpler choice.
 */
function includedShasForPlan(planRelPath) {
  const absPath = abs(planRelPath);
  if (!fs.existsSync(absPath)) return [];
  const { meta } = readPlan(absPath);
  return normalizeShaList(meta?.commits_include);
}

/**
 * Return the list of short shas whose commit message contains a `Plan: <path>`
 * trailer (case-insensitive prefix match), plus anything the plan claims via
 * `commits_include:`, minus anything it disowns via `commits_exclude:`.
 * Oldest-derived-first, included shas appended after. Returns [] if git fails
 * or the path matches nothing and there are no includes either.
 *
 * Merge-then-filter, in that order, is what makes exclude win when a sha
 * appears in both fields: an include can add a sha the derive step missed,
 * but the exclude pass runs after and still drops it. This happens HERE, not
 * in a caller, because every consumer has to see the same truth: `commits
 * --sync`, the post-commit incremental sync, the full `index` regen, and the
 * plain `commits` listing all funnel through this one function.
 */
function commitsForPlan(planPath) {
  const safe = planPath.replace(/[.[\]\\^$|()?*+{}]/g, '\\$&');
  // Anchor to BOL; case-insensitive via --regexp-ignorecase below.
  // trailerGrepPattern (lib/commits.mjs) supplies the shared tail — tolerates
  // exactly ONE trailing parenthetical annotation (`Plan: <path> (Task 1)`),
  // never arbitrary trailing text — shared with cmdPostCommit's extraction
  // regex so the two "what counts as a Plan: trailer" definitions in this
  // file cannot drift from each other again (see lib/commits.mjs's comment
  // for why: a plain derivation-only fix here once left the post-commit
  // incremental sync silently no-opping for annotated trailers).
  const pattern = trailerGrepPattern(safe);
  let derived;
  try {
    const out = execSync(
      `git -C ${JSON.stringify(REPO_ROOT)} log -i --extended-regexp ` +
      `--grep=${JSON.stringify(pattern)} --pretty=format:%h --reverse`,
      { stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString();
    derived = out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    derived = [];
  }
  const merged = mergeIncludedCommits(derived, includedShasForPlan(planPath));
  return filterExcludedCommits(merged, excludedShasForPlan(planPath));
}

/**
 * Sync a single plan's `commits` frontmatter field with what's in git.
 * Returns true when the file was rewritten, false when already in sync (the
 * latter is the common case so we skip unnecessary mtime churn).
 */
function syncCommitsForPlan(planAbsPath, planRelPath) {
  if (!fs.existsSync(planAbsPath)) return false;
  const { meta } = readPlan(planAbsPath);
  if (!meta) return false; // legacy plans without frontmatter — leave alone
  const next = commitsForPlan(planRelPath);
  // Normalized: a stored all-digit sha parses back as a NUMBER, which would
  // never compare equal to the derived string and would rewrite the file (and
  // its mtime) on every single sync.
  const current = normalizeShaList(meta.commits);
  if (current.length === next.length && current.every((v, i) => v === next[i])) {
    return false;
  }
  // Empty list → drop the field entirely (idempotent regen).
  const updates = next.length > 0
    ? { commits: next }
    : { commits: undefined };
  if (updates.commits === undefined) {
    // writePlanFrontmatter doesn't have a delete path; do it inline.
    const text = fs.readFileSync(planAbsPath, 'utf8');
    const parsed = parseFrontmatter(text);
    if (parsed.meta && 'commits' in parsed.meta) {
      delete parsed.meta.commits;
      parsed.meta.__order = parsed.meta.__order.filter(k => k !== 'commits');
      const fm = stringifyFrontmatter(parsed.meta);
      fs.writeFileSync(planAbsPath, fm + '\n' + parsed.body);
    }
  } else {
    writePlanFrontmatter(planAbsPath, updates);
  }
  return true;
}

/**
 * Backfill helper: for plans authored before the trailer hook existed, propose
 * candidate commits whose subject mentions the plan's filename slug. Output is
 * advisory — the operator reviews and pastes accepted shas into the plan's
 * `commits_include:` frontmatter. Never auto-writes (per the plan's design).
 *
 * ⚠️ THE DESTINATION IS `commits_include:`, NOT `commits:`. This used to say
 * `commits:`, and following it silently lost data: `commits:` is rebuilt
 * WHOLESALE from git trailers by syncCommitsForPlan on every sync, so a
 * hand-pasted sha there survives only until the next sync of that plan — at
 * which point it is dropped with no warning, and if the derived list comes back
 * empty the whole field is deleted. Measured 2026-08-04: two plans
 * (dependency-hygiene-and-ci, fleet-image-reproducibility) carried eight
 * hand-authored shas between them, none of which had a `Plan:` trailer, and a
 * routine `index` regen erased all eight. `commits_include:` is the field
 * designed for precisely this case and every sync path re-applies it, so the
 * output below names it explicitly rather than trusting the reader to know.
 */
function cmdCommitsSuggest(args = []) {
  const positional = args.filter(a => !a.startsWith('-'));
  const planPathArg = positional[0];

  // Build the candidate set: a single plan or every plan with frontmatter that
  // doesn't already have a `commits:` field populated.
  let plans;
  if (planPathArg) {
    const rel = resolveRel(planPathArg);
    const absPath = abs(rel);
    if (!fs.existsSync(absPath)) die(`Plan not found: ${rel}`);
    plans = [{ absPath, relPath: rel, tree: rel.split('/')[0] }];
  } else {
    plans = listPlans().filter(p => {
      const { meta } = readPlan(p.absPath);
      return meta && (!Array.isArray(meta.commits) || meta.commits.length === 0);
    });
  }

  for (const plan of plans) {
    // Slug = filename without leading date and .md (e.g. "multi-agent-work-tracker").
    // We try TWO precise matchers in order, never the noisy token alternation:
    //   1. literal slug ("multi-agent-work-tracker") — high precision
    //   2. words form  ("multi agent work tracker") — accepts space-separated mentions
    const base = path.basename(plan.relPath, '.md');
    const slug = base.replace(/^\d{4}-\d{2}-\d{2}(-\d{2})?-/, '');
    if (slug.length < 6) continue; // too short, would false-positive

    const safeSlug = slug.replace(/[.[\]\\^$|()?*+{}]/g, '\\$&');
    const wordsForm = slug.replace(/-/g, '[-_ ]');

    let raw = '';
    for (const pattern of [safeSlug, wordsForm]) {
      try {
        raw = execSync(
          `git -C ${JSON.stringify(REPO_ROOT)} log -i --extended-regexp ` +
          `--grep=${JSON.stringify(pattern)} --pretty=format:'%h%x09%s' --reverse`,
          { stdio: ['ignore', 'pipe', 'ignore'] },
        ).toString();
      } catch {
        raw = '';
      }
      if (raw.trim()) break;
    }
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length === 0) continue;

    // Drop commits that already have a Plan: trailer (any plan) — those are
    // either correctly attributed already or intentionally pointed elsewhere.
    const haveTrailer = new Set();
    try {
      const trailerOut = execSync(
        `git -C ${JSON.stringify(REPO_ROOT)} log -i --extended-regexp ` +
        `--grep=${JSON.stringify('^plan:[ \\t]+')} --pretty=format:%h`,
        { stdio: ['ignore', 'pipe', 'ignore'] },
      ).toString();
      for (const sha of trailerOut.split('\n').filter(Boolean)) haveTrailer.add(sha);
    } catch {}

    const filtered = lines.filter(l => !haveTrailer.has(l.split('\t')[0]));
    if (filtered.length === 0) continue;

    console.log(`\n${plan.relPath}  (${filtered.length} candidate${filtered.length === 1 ? '' : 's'})`);
    console.log(`  → paste accepted shas into commits_include:  (NOT commits: — that field is rebuilt from git trailers on every sync)`);
    for (const l of filtered) {
      const [sha, subject] = l.split('\t');
      console.log(`  ${sha}  ${subject}`);
    }
  }
}

function cmdCommits(args = []) {
  // Subcommands: `commits suggest [<plan>]` for backfill help.
  if (args[0] === 'suggest') return cmdCommitsSuggest(args.slice(1));
  const sync = args.includes('--sync');
  const positional = args.filter(a => !a.startsWith('-'));
  let planPath = positional[0];
  if (!planPath) {
    const rec = readSession();
    if (!rec) die('No claim in this session, and no plan path given. Usage: commits [<plan-path>] [--sync]');
    planPath = rec.plan_path;
  }
  const rel = resolveRel(planPath);
  const absPath = abs(rel);
  if (!fs.existsSync(absPath)) die(`Plan not found: ${rel}`);

  const shas = commitsForPlan(rel);
  if (sync) {
    const changed = syncCommitsForPlan(absPath, rel);
    console.log(`${rel} — ${shas.length} commit(s)${changed ? ' (synced)' : ' (unchanged)'}`);
  } else {
    if (shas.length === 0) {
      console.log(`(no commits with "${TRAILER_PREFIX}${rel}" trailer)`);
      return;
    }
    // Print short sha + subject for each, in `shas` order (already merged with
    // commits_include and filtered by commits_exclude — this is the command an
    // operator runs to confirm either repair took, so it must report the same
    // truth every other path does). Look each sha's subject up directly with
    // `git show`, one call per sha, rather than a single trailer-grep `git log`:
    // an included sha is included PRECISELY BECAUSE it may carry no trailer for
    // this plan (or the wrong one), so a trailer-grep would never find its
    // subject at all — that was true of the pre-commits_include display, which
    // is why it's gone.
    const lines = [];
    for (const sha of shas) {
      try {
        const out = execSync(
          `git -C ${JSON.stringify(REPO_ROOT)} show -s --format=${JSON.stringify('%h %s')} ${JSON.stringify(sha)}`,
          { stdio: ['ignore', 'pipe', 'ignore'] },
        ).toString().trim();
        if (out) lines.push(out);
      } catch {
        // Unresolvable sha (typo, or a commit not reachable in this repo) — skip
        // rather than print a blank or throw; same leniency commits_exclude has
        // toward an entry that never matched anything.
      }
    }
    console.log(lines.join('\n'));
  }
}

// ─── Trailer (called by .claude/githooks/prepare-commit-msg) ──────────────

/**
 * Called by .claude/githooks/post-commit. Reads HEAD's commit message, extracts
 * any `Plan: <path>` trailers, syncs each referenced plan's `commits:`
 * frontmatter, then re-runs INDEX without the slow per-plan git-grep loop
 * (the just-touched plans are already up to date from the per-plan sync above).
 *
 * Cost: ~1 git invocation per Plan: trailer + 1 cheap regen. Sub-300ms.
 */
function cmdPostCommit() {
  let body;
  try {
    body = execSync(
      `git -C ${JSON.stringify(REPO_ROOT)} log -1 --format=%B`,
      { stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString();
  } catch {
    return;
  }
  // TRAILER_LINE_RE (lib/commits.mjs) — the shared trailer definition, so this
  // extraction can't drift from commitsForPlan's derivation grep the way it
  // did before (see that function's comment, and lib/commits.mjs's).
  const paths = new Set();
  for (const line of body.split('\n')) {
    const m = line.match(TRAILER_LINE_RE);
    if (m) paths.add(m[1]);
  }
  if (paths.size === 0) return;

  for (const rel of paths) {
    const absPath = abs(rel);
    if (fs.existsSync(absPath)) syncCommitsForPlan(absPath, rel);
  }
  regenerateIndex({ syncCommits: false });
}

function cmdTrailer(args = []) {
  const file = args[0];
  const source = args[1] || '';
  if (!file || !fs.existsSync(file)) return; // silent — git will fail on its own

  // Every "should we stamp?" rule lives in lib/trailer.mjs (source, opt-out,
  // fallback id, stale claim). We stay silent whatever it decides: this runs
  // inside prepare-commit-msg, whose contract is never to block or chatter.
  const decision = trailerDecision({
    source,
    record: readSession(),
    sessionId: sessionId(),
    env: process.env,
    staleHours: STALE_HOURS,
  });
  if (!decision.stamp) return;
  const trailer = TRAILER_PREFIX + decision.planPath;

  const original = fs.readFileSync(file, 'utf8');

  // Strip git's commented-out instructions before checking for an existing
  // trailer — but preserve them in the output.
  const visible = original.split('\n').filter(l => !l.startsWith('#')).join('\n');
  if (visible.split('\n').some(l => l.trim() === trailer)) return;

  // Insert trailer just before the first comment block (git puts its '# Please
  // enter the commit message...' lines after the user's content). Falls back
  // to appending at the end.
  const lines = original.split('\n');
  let insertAt = lines.findIndex(l => l.startsWith('#'));
  if (insertAt === -1) insertAt = lines.length;

  // Walk backwards to skip blank lines so the trailer hugs the body.
  let bodyEnd = insertAt - 1;
  while (bodyEnd >= 0 && lines[bodyEnd].trim() === '') bodyEnd--;

  const before = lines.slice(0, bodyEnd + 1);
  const after = lines.slice(insertAt);

  // One blank line between body and trailer, exactly.
  const block = before.length > 0 ? [...before, '', trailer, ''] : [trailer, ''];
  const out = [...block, ...after].join('\n');

  fs.writeFileSync(file, out);
}

function cmdWhere() {
  const rec = readSession();
  if (!rec) {
    console.log('no claim in this session');
    console.log(`session id: ${sessionId()}`);
    console.log(`branch: ${gitBranch() || '?'}`);
    return;
  }
  const absPath = abs(rec.plan_path);
  const plan = fs.existsSync(absPath) ? summarize({ absPath, relPath: rec.plan_path, tree: '' }) : null;
  console.log(`claimed: ${rec.plan_path}`);
  if (plan) {
    console.log(`title: ${plan.title}`);
    console.log(`status: ${plan.status}   priority: ${plan.priority || '-'}`);
    if (plan.summary) console.log(`summary: ${plan.summary}`);
  }
  console.log(`branch: ${rec.branch || '?'}   heartbeat: ${relTime(rec.last_heartbeat)}`);
  try {
    const log = execSync(`git -C ${JSON.stringify(REPO_ROOT)} log --oneline -3`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    console.log('\nrecent commits:');
    log.split('\n').forEach(l => console.log('  ' + l));
  } catch {}
}

// ─── Skills map ───────────────────────────────────────────────────────────
//

// ─── Dispatch ─────────────────────────────────────────────────────────────

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function main() {
  let [cmd, ...args] = process.argv.slice(2);
  // Bare flags (no command) → board
  if (cmd && cmd.startsWith('-')) {
    args = [cmd, ...args];
    cmd = 'board';
  }
  switch (cmd) {
    case undefined:
    case 'board': return cmdBoard(args);
    case 'new': return cmdNew(args);
    case 'claim': return cmdClaim(args);
    case 'tick': return cmdTick(args);
    case 'status': return cmdStatus(args);
    case 'release': return cmdRelease(args);
    case 'index':
      if (args.includes('--prune')) cmdPrune(args.filter(a => a !== '--prune'));
      return cmdIndex();
    case 'where': return cmdWhere();
    case 'graph': return cmdGraph(args);
    case 'prune': return cmdPrune(args);
    case 'resume': return cmdResume(args);
    case 'trailer': return cmdTrailer(args);
    case 'post-commit': return cmdPostCommit();
    case 'commits': return cmdCommits(args);
    case 'help': case '-h': case '--help':
      console.log(`/plans — multi-agent work tracker

Status:
  (no args)          board: active sessions, then blocked, then planning
  where              re-orient: current claim + plan summary + last 3 commits
  graph              ASCII dependency tree of plans with depends_on

Lifecycle (within a claimed session):
  claim <plan-path>  mark this terminal as claimant; auto-bumps planning → active
  tick [--quiet]     heartbeat session + bump last_touched on the claimed plan
  status <state>     idea | planning | active | blocked | shipped | parked
  release            drop the claim (doesn't change status)
                     claim/status/release refuse to run under a collision-prone
                     'fallback-' session id; pass --force to accept the risk.

Commit linkage:
  PLANS_NO_TRAILER=1 git commit …    skip the Plan: trailer on one commit
  commits_exclude: [<short-shas>]    plan frontmatter — disown a commit whose
                     trailer is wrong (trailers in history can't be rewritten);
                     every sync path re-applies it
  commits_include: [<short-shas>]    plan frontmatter — claim a commit that has
                     no usable trailer for this plan (none at all, or another
                     plan's); merged in by the same sync paths. exclude wins
                     if a sha is in both.

Authoring & maintenance:
  new <slug>         scaffold from plans/TEMPLATE.md → plans/<date>-<slug>.md
                     [--scope <path>]  pick tree (default: plans)
                     [--series]        prefix with the next number in that series (scope dir)
  index [--prune]    regenerate plans/INDEX.md + INDEX.json (and optionally clear stale claims)
  prune [--dry-run]  clear session records older than 4h heartbeat
  resume [<plan>]    print 'claude --resume <id>' commands for active claims (or just one)

Skills map:
                     "relevant but not visible from here" section
                     --check   diff against the committed map, no write; exit 1 if stale

Filters (board, graph):
  --tag <name>       only plans tagged <name>
  --status <state>   only plans with that status
  --scope <path>     only plans under that path prefix
  --all              include shipped/parked/idea (board only)
`);
      return;
    default: die(`unknown command: ${cmd}`);
  }
}

main();
