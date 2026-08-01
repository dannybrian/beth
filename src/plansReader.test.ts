import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlansReader, discoverRoots, extractTitle, parseFrontmatter, parseTasks } from './plansReader.ts';

const lines = (s: string) => s.split('\n');

test('frontmatter: scalars, lists, and null-as-absent', () => {
  const { fm, bodyLine } = parseFrontmatter(
    ['---', 'status: active', 'owner: null', 'priority: P1', 'tags: [director, tooling]', 'worktree: ~', '---', '', '# Title'].join('\n')
  );
  assert.equal(fm.status, 'active');
  assert.equal(fm.priority, 'P1');
  assert.deepEqual(fm.tags, ['director', 'tooling']);
  assert.equal(fm.owner, undefined, 'null is absent, not the string "null"');
  assert.equal(fm.worktree, undefined);
  assert.equal(bodyLine, 7);
});

test('frontmatter: a BLOCK list is read, not silently dropped', () => {
  // tulito writes depends_on this way in 27 of its plans against 21 inline.
  // Handling only `[a, b]` dropped more than half its relations — and with them
  // most of the umbrella parentage the panel needs to nest anything.
  const { fm } = parseFrontmatter(
    ['---', 'status: active', 'depends_on:', '  - plans/a.md', '  - plans/b.md', 'priority: P1', '---', '', '# T'].join('\n')
  );
  assert.deepEqual(fm.depends_on, ['plans/a.md', 'plans/b.md']);
  assert.equal(fm.priority, 'P1', 'the key after the block list is still read');
  assert.equal(fm.status, 'active');
});

test('frontmatter: a bare key with nothing under it is absent', () => {
  const { fm } = parseFrontmatter(['---', 'depends_on:', 'priority: P2', '---', '', '# T'].join('\n'));
  assert.equal(fm.depends_on, undefined);
  assert.equal(fm.priority, 'P2');
});

test('frontmatter: trailing YAML comments are not part of the value', () => {
  // The plan TEMPLATE ships fields annotated this way; a plan scaffolded from it
  // that kept the comment would otherwise get a status of "planning   # idea |…".
  const { fm } = parseFrontmatter(
    ['---', 'status: planning   # idea | planning | active', 'tags: [a, b]   # free-form', '---', '', '# T'].join('\n')
  );
  assert.equal(fm.status, 'planning');
  assert.deepEqual(fm.tags, ['a', 'b']);
});

test('frontmatter: a plan without any is not an error', () => {
  const { fm, bodyLine } = parseFrontmatter('# Just a title\n\nprose');
  assert.deepEqual(fm, {});
  assert.equal(bodyLine, 0);
});

test('title comes from the first H1, not frontmatter', () => {
  const text = ['---', 'status: active', '---', '', '## Not this', '', '# The real title', '', '# A later one'].join('\n');
  const { bodyLine } = parseFrontmatter(text);
  assert.equal(extractTitle(lines(text), bodyLine, 'plans/x.md'), 'The real title');
});

test('title falls back to the filename so a malformed plan stays visible', () => {
  assert.equal(extractTitle(['no heading here'], 0, 'plans/2026-01-01-orphan.md'), '2026-01-01-orphan');
});

test('tasks: counted, with done state, line numbers and depth', () => {
  const text = ['# T', '', '- [ ] First', '- [x] Second', '  - [X] Nested', '* [ ] Star bullet', 'not a task'].join('\n');
  const tasks = parseTasks(lines(text), 0);
  assert.equal(tasks.length, 4);
  assert.deepEqual(
    tasks.map((t) => t.done),
    [false, true, true, false]
  );
  assert.equal(tasks[0].line, 3, '1-based, for a VSCode jump');
  assert.equal(tasks[2].depth, 1);
});

test('tasks: checkboxes inside fenced code are samples, not work', () => {
  // The bug this prevents: fenced examples inflate a plan's task total with
  // work that does not exist, and the panel reports progress against fiction.
  const text = [
    '# T',
    '- [x] A real task',
    '',
    '```markdown',
    '- [ ] example in a code fence',
    '- [ ] another example',
    '```',
    '',
    '- [ ] Another real task',
    '~~~',
    '- [ ] tilde-fenced example',
    '~~~',
  ].join('\n');
  const tasks = parseTasks(lines(text), 0);
  assert.equal(tasks.length, 2);
  assert.deepEqual(
    tasks.map((t) => t.text),
    ['A real task', 'Another real task']
  );
});

test('tasks: a prose plan yields none — the common case', () => {
  const text = ['# T', '', '## Context', 'Some prose about the work.', '', '## Approach', 'More prose.'].join('\n');
  assert.deepEqual(parseTasks(lines(text), 0), []);
});

// --- reader over a real directory tree -------------------------------------

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-reader-'));
  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  write('plans/2026-01-01-alpha.md', '---\nstatus: active\nowner: claude-live\n---\n\n# Alpha — the first one\n\n- [x] done\n- [ ] todo\n');
  write('plans/INDEX.md', '# generated, not a plan');
  write('plans/README.md', '# also not a plan');
  write('plans/future/2026-01-02-parked-idea.md', '# A parked idea\n\nno frontmatter at all\n');
  // A second, deeper plans root — the shape that "plans/**/*.md" would miss.
  write('game/plans/unity/2026-01-03-140-beta.md', '---\nstatus: blocked\n---\n\n# Beta\n');
  write('node_modules/pkg/plans/2026-01-04-nope.md', '---\nstatus: active\n---\n\n# Should never appear\n');
  fs.mkdirSync(path.join(dir, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude', 'sessions', 'claude-live.json'),
    JSON.stringify({ session_id: 'claude-live', plan_path: 'plans/2026-01-01-alpha.md', last_heartbeat: new Date().toISOString() })
  );
  return dir;
}

test('discovery finds every directory named plans, and skips node_modules', () => {
  const dir = fixture();
  const roots = discoverRoots(dir).map((r) => path.relative(dir, r));
  assert.deepEqual(roots.sort(), ['game/plans', 'plans']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reader produces the harness shape from a real tree', () => {
  const dir = fixture();
  const items = createPlansReader({ repo: dir }).read();
  const byPath = new Map(items.map((i) => [i.path, i]));

  assert.equal(items.length, 3, 'INDEX.md, README.md and node_modules are excluded');

  const alpha = byPath.get('plans/2026-01-01-alpha.md')!;
  assert.equal(alpha.title, 'Alpha — the first one');
  assert.equal(alpha.status, 'active');
  assert.equal(alpha.tasks.length, 2);
  assert.equal(alpha.claim?.live, true, 'a fresh session record naming this plan is a live claim');

  assert.equal(byPath.get('game/plans/unity/2026-01-03-140-beta.md')?.status, 'blocked');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('awaiting-eyes and review survive as themselves, not as unknown', () => {
  // tulito's vocabulary adds `awaiting-eyes` and its own plans/README calls it
  // "the reason this workflow was ported" — the batched-confirmation signal.
  // Falling to `unknown` dropped it out of the live set entirely, so the one
  // queue only Danny can clear was the one thing the panel hid.
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'plans', '2026-01-05-eyes.md'), '---\nstatus: awaiting-eyes\n---\n\n# Needs a look\n');
  fs.writeFileSync(path.join(dir, 'plans', '2026-01-06-rev.md'), '---\nstatus: review\n---\n\n# Needs reclassifying\n');
  const items = createPlansReader({ repo: dir }).read();
  const byPath = new Map(items.map((i) => [i.path, i]));
  assert.equal(byPath.get('plans/2026-01-05-eyes.md')?.status, 'awaiting-eyes');
  assert.equal(byPath.get('plans/2026-01-06-rev.md')?.status, 'review');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a plan under future/ without frontmatter is parked, not unknown', () => {
  // Mirrors the /plans skill's inference. Without it, dozens of long-abandoned
  // parking-lot ideas surface as `unknown` and land in the panel.
  const dir = fixture();
  const items = createPlansReader({ repo: dir }).read();
  assert.equal(items.find((i) => i.path.includes('future'))?.status, 'parked');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a stale session record is an owner but not a live claim', () => {
  // The distinction the handoff has to refuse on: dangling `owner:` frontmatter
  // is not an implementer at work.
  const dir = fixture();
  const old = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(
    path.join(dir, '.claude', 'sessions', 'claude-live.json'),
    JSON.stringify({ session_id: 'claude-live', plan_path: 'plans/2026-01-01-alpha.md', last_heartbeat: old })
  );
  const alpha = createPlansReader({ repo: dir }).read().find((i) => i.path.endsWith('alpha.md'))!;
  assert.equal(alpha.claim?.owner, 'claude-live');
  assert.equal(alpha.claim?.live, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
