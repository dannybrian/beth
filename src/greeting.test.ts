import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Greetings, OnboardingOffer, kickoffPrompt, repoSnapshot, unreadPlanFiles, type Opening } from './greeting.ts';
import type { HarnessConfig } from './config.ts';
import type { WorkItem } from './workItems.ts';

const store = () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-greeting-'));
  return new Greetings({ stateDir } as HarnessConfig);
};

const item = (spoken: string) => ({ spoken, status: 'active', tasks: [] }) as unknown as WorkItem;

const prompt = (over: Partial<Parameters<typeof kickoffPrompt>[0]> = {}) =>
  kickoffPrompt({
    now: new Date('2026-08-02T09:15:00'),
    repoName: 'tulito',
    snapshot: { branch: 'main', dirty: 0, lastCommit: { subject: 'Say what is here now', age: '2 hours ago' } },
    live: [],
    priors: [],
    lastAt: null,
    ...over,
  });

test('an opening is remembered, newest first, and the file caps', () => {
  const g = store();
  for (const t of ['one', 'two', 'three', 'four', 'five', 'six', 'seven']) g.record(t);
  const recent = g.recent();
  assert.equal(recent[0].text, 'seven');
  assert.equal(recent.length, 6, 'six is enough to show a rut without bloating the prompt');
  assert.ok(!recent.some((r) => r.text === 'one'), 'the oldest fell off');
});

test('a missing or corrupt store is empty, not fatal — a greeting must not fail on it', () => {
  const g = store();
  assert.deepEqual(g.recent(), []);
  assert.equal(g.lastAt(), null);
  fs.writeFileSync(path.join(os.tmpdir(), 'nope'), '');
  const broken = store();
  (broken as unknown as { file: string }).file = path.join(os.tmpdir(), 'nope');
  assert.deepEqual(broken.recent(), []);
});

test('multi-line openings are flattened — the prompt lists them one per line', () => {
  const g = store();
  g.record('  Morning.\n\nTree is clean.  ');
  assert.equal(g.recent()[0].text, 'Morning. Tree is clean.');
});

// The whole point of the feature: she cannot know she has a habit, because the
// conversation that formed it is not in this one.
test('the priors are handed back with an instruction not to reuse them', () => {
  const priors: Opening[] = [
    { at: '2026-08-01T09:00:00Z', text: "Morning's yours to name, Danny — Tulito's up on main, tree clean." },
    { at: '2026-07-31T09:00:00Z', text: "Morning's yours to name, Danny — Tulito's up on main, tree clean." },
  ];
  const p = prompt({ priors });
  assert.ok(p.includes("Morning's yours to name"), 'the actual sentence, not a summary of it');
  assert.match(p, /Do not reuse them/);
});

test('with nothing to avoid, no prior section at all', () => {
  const p = prompt();
  assert.ok(!/Do not reuse/.test(p));
  assert.ok(!/last openings/.test(p));
});

test('the facts are material, and the tree state is one of them', () => {
  const p = prompt({ snapshot: { branch: 'voice-plane', dirty: 3, lastCommit: null } });
  assert.match(p, /tulito, on voice-plane, 3 files uncommitted/);
  assert.ok(!/tree clean/.test(p));
});

test('in-flight work is named, spoken form only — never a path', () => {
  const p = prompt({ live: [item('the context diet plan'), item('geo pins'), item('the voice plane'), item('a fourth')] });
  assert.match(p, /4 in flight/);
  assert.match(p, /"the context diet plan"/);
  assert.match(p, /and others/, 'four does not mean list all four');
});

// A restart ninety seconds later is a different greeting because it is a
// different morning — this is the fact that makes it one.
test('a restart is told from an arrival', () => {
  const now = new Date('2026-08-02T09:15:00');
  assert.match(prompt({ now, lastAt: now.getTime() - 90_000 }), /RESTART/);
  assert.match(prompt({ now, lastAt: now.getTime() - 4 * 3600_000 }), /about 4 hours ago/);
  assert.match(prompt({ now, lastAt: now.getTime() - 3 * 24 * 3600_000 }), /3 days ago/);
  assert.match(prompt({ now, lastAt: null }), /first time you have booted/);
});

test('still ONE sentence, and still not via the say tool', () => {
  // The triple-greeting bug: two carriers for one line, both spoken.
  const p = prompt();
  assert.match(p, /ONE short sentence/);
  assert.match(p, /Do not call the say tool/);
});

test('a snapshot of a real repo reads the branch; a directory without git is all nulls', () => {
  const here = repoSnapshot(process.cwd());
  assert.equal(typeof here.branch, 'string');
  assert.equal(typeof here.dirty, 'number');
  assert.ok(here.lastCommit && here.lastCommit.subject.length > 0);

  const bare = repoSnapshot(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-nogit-')));
  assert.deepEqual(bare, { branch: null, dirty: null, lastCommit: null });
});

// --- the onboarding offer ----------------------------------------------------
//
// Two invisible failure modes: an offer that repeats every boot (a nag), and an
// offer that never fires (the feature silently absent). Both are bookkeeping,
// which is what makes them testable here.

test('onboarding facts ride as material, evidence first', () => {
  const p = prompt({ onboarding: { noGuide: true, unreadPlans: { dir: 'plans/', count: 34 } } });
  // The unread-plans line wins over the bare no-guide line: it has evidence.
  assert.match(p, /34 markdown files sit in plans\//);
  assert.match(p, /director-skills/);
  // Still one sentence: the offer is a fact to fold in, not a second ask.
  assert.match(p, /ONE short sentence/);
  assert.doesNotMatch(p, /no \.claude\/DIRECTOR\.md and no plans/, 'one offer line, not two');
});

test('no guide alone still offers, quietly', () => {
  const p = prompt({ onboarding: { noGuide: true, unreadPlans: null } });
  assert.match(p, /no \.claude\/DIRECTOR\.md/);
});

test('a repo with no onboarding gap says nothing about it', () => {
  assert.doesNotMatch(prompt(), /director-skills/);
});

test('the offer is once, ever, per repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-onboard-'));
  const offer = new OnboardingOffer({ stateDir: dir } as any);
  assert.equal(offer.offered(), false);
  offer.markOffered();
  assert.equal(offer.offered(), true);
  // A new instance — a restart — still knows.
  assert.equal(new OnboardingOffer({ stateDir: dir } as any).offered(), true);
});

test('unread plans are counted only when the index read nothing', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-unread-'));
  fs.mkdirSync(path.join(repo, 'plans'));
  fs.writeFileSync(path.join(repo, 'plans', '2026-01-01-a.md'), 'x');
  fs.writeFileSync(path.join(repo, 'plans', 'README.md'), 'x');
  assert.deepEqual(unreadPlanFiles(repo, 0), { dir: 'plans/', count: 1 }, 'README is not a plan');
  assert.equal(unreadPlanFiles(repo, 5), null, 'an index that reads plans has no unread case');
  assert.equal(unreadPlanFiles(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-noplans-')), 0), null);
});
