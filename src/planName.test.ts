import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setPlanName, cleanName, MAX_NAME } from './planName.ts';
import { parseFrontmatter } from './plansReader.ts';

/** A repo with one plan in it, shaped like the real ones. */
function repo(body = '---\nstatus: active\npriority: P1\n---\n\n# Notation view\n\n- [ ] one\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-rename-'));
  fs.mkdirSync(path.join(dir, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plans', '2026-01-01-alpha.md'), body);
  return dir;
}
const read = (dir: string) => fs.readFileSync(path.join(dir, 'plans', '2026-01-01-alpha.md'), 'utf8');
const REL = 'plans/2026-01-01-alpha.md';

test('a name is inserted, and the READER agrees it is there', () => {
  // Writer and reader disagreeing is the one failure this module cannot have.
  const dir = repo();
  assert.deepEqual(setPlanName(dir, REL, 'Notation view'), { ok: true, name: 'Notation view', path: REL });
  assert.equal(parseFrontmatter(read(dir)).fm.name, 'Notation view');
});

test('a hand-off from the inbox cannot be renamed — no file, no frontmatter', () => {
  const dir = repo();
  const r = setPlanName(dir, 'inbox/memobase/m1', 'the settle window');
  assert.equal(r.ok, false);
});

test('nothing else in the file is touched', () => {
  const dir = repo();
  const before = read(dir);
  setPlanName(dir, REL, 'Notation view');
  const after = read(dir);
  assert.equal(after.replace('name: Notation view\n', ''), before, 'one line added, byte for byte otherwise');
  assert.ok(after.includes('- [ ] one'), 'the body survives');
  assert.ok(after.includes('priority: P1'), 'and so do the other keys');
});

test('an existing name is replaced in place, keeping the author\'s field order', () => {
  const dir = repo('---\nstatus: active\nname: Old name\npriority: P1\n---\n\n# Alpha\n');
  setPlanName(dir, REL, 'New name');
  const lines = read(dir).split('\n');
  assert.equal(lines[2], 'name: New name', 'same position it was in');
  assert.equal(lines.filter((l) => l.startsWith('name:')).length, 1, 'not two names');
});

// ⚠️ A `#` cannot survive this parser however it is written: it strips a trailing
// ` #…` as a YAML comment BEFORE it strips quotes, so `name: "Engine v7 #2"`
// reads back as `Engine v7`. Quoting makes it worse. Refuse, and say why.
test('a name containing # is refused with a reason, not silently truncated', () => {
  const dir = repo();
  const r = setPlanName(dir, REL, 'Engine v7 #2');
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /#/);
  assert.equal(parseFrontmatter(read(dir)).fm.name, undefined, 'the file is untouched');
});

test('a name the parser CAN read once quoted round-trips', () => {
  const dir = repo();
  assert.equal(setPlanName(dir, REL, "'Round' one").ok, true);
  assert.equal(parseFrontmatter(read(dir)).fm.name, "'Round' one");
});

test('a colon inside a name needs no help — the parser splits on the first one', () => {
  const dir = repo();
  assert.equal(setPlanName(dir, REL, 'Notation: the view').ok, true);
  assert.equal(parseFrontmatter(read(dir)).fm.name, 'Notation: the view');
});

test('a name containing a double quote is refused, not mangled', () => {
  const dir = repo();
  const r = setPlanName(dir, REL, 'The "good" plan');
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /double quote/);
  assert.equal(parseFrontmatter(read(dir)).fm.name, undefined, 'and the file is untouched');
});

// ⚠️ The standing rule is that the harness never REPAIRS frontmatter. Creating a
// block where there is none is exactly that, and it belongs to /tidyrepo.
test('a plan with no frontmatter is refused rather than repaired', () => {
  const dir = repo('# Alpha\n\nJust a body.\n');
  const before = read(dir);
  const r = setPlanName(dir, REL, 'Alpha');
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /tidyrepo/);
  assert.equal(read(dir), before);
});

test('unclosed frontmatter is refused too', () => {
  const dir = repo('---\nstatus: active\n\n# Alpha\n');
  assert.equal(setPlanName(dir, REL, 'Alpha').ok, false);
});

// This endpoint takes a path from a page and WRITES to it.
test('a path outside the repo cannot be written to', () => {
  const dir = repo();
  for (const bad of ['../../../etc/passwd', '../escape.md', '/etc/hosts']) {
    const r = setPlanName(dir, bad, 'nope');
    assert.equal(r.ok, false, bad);
    assert.match((r as { reason: string }).reason, /outside the repo|not a markdown file|no such plan/);
  }
});

test('a missing plan or a non-markdown path is refused', () => {
  const dir = repo();
  assert.equal(setPlanName(dir, 'plans/nope.md', 'x').ok, false);
  assert.equal(setPlanName(dir, 'plans/thing.txt', 'x').ok, false);
});

test('an empty name is refused — a plan with no name is worse than a derived one', () => {
  const dir = repo();
  assert.equal(setPlanName(dir, REL, '   ').ok, false);
  assert.equal(setPlanName(dir, REL, '').ok, false);
});

test('a name is one sayable line', () => {
  assert.equal(cleanName('  Notation \n\n view  '), 'Notation view');
  assert.equal(cleanName('tabs\tandcontrol'), 'tabs and control');
  assert.equal(cleanName('x'.repeat(200)).length, MAX_NAME);
});
