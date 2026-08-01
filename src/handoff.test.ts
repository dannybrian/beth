import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommand, canHandOff, seedPrompt } from './handoff.ts';
import { WorkIndex } from './workIndex.ts';
import type { WorkItemDraft } from './workItems.ts';

const item = (over: Partial<WorkItemDraft> = {}): WorkItemDraft => ({
  path: 'plans/2026-01-01-alpha.md',
  title: 'Alpha — the first one',
  status: 'active',
  tags: [],
  claim: null,
  tasks: [],
  reader: 'test',
  ...over,
});

function indexOf(...items: WorkItemDraft[]): WorkIndex {
  const idx = new WorkIndex([{ name: 'test', watchRoots: () => [], read: () => items }]);
  idx.refresh();
  return idx;
}

test('an unclaimed plan can be handed off', () => {
  const v = canHandOff(indexOf(item()), 'plans/2026-01-01-alpha.md');
  assert.equal(v.ok, true);
  assert.match(v.reason, /unclaimed/);
});

test('a LIVE claim refuses, and names who holds it', () => {
  // The discipline this protects: one implementer at a time. A second session
  // started quietly on a claimed plan is exactly the regression to avoid.
  const idx = indexOf(item({ claim: { owner: 'claude-abc', live: true, lastHeartbeat: '2026-08-01T10:00:00Z' } }));
  const v = canHandOff(idx, 'plans/2026-01-01-alpha.md');
  assert.equal(v.ok, false);
  assert.match(v.reason, /claude-abc/);
  assert.match(v.reason, /one implementer at a time/i);
});

test('a STALE owner does not block, but is called out', () => {
  // A dangling `owner:` is not an implementer at work — refusing would lock a
  // plan nobody holds.
  const idx = indexOf(item({ claim: { owner: 'claude-old', live: false } }));
  const v = canHandOff(idx, 'plans/2026-01-01-alpha.md');
  assert.equal(v.ok, true);
  assert.match(v.reason, /stale/);
});

test('a plan not in the index refuses rather than guessing', () => {
  assert.equal(canHandOff(indexOf(item()), 'plans/nope.md').ok, false);
});

test('the seeded prompt makes the SESSION claim the plan, never the harness', () => {
  // The harness is a reader — /plans is the only writer. So the handoff seeds an
  // instruction to claim, rather than claiming on its behalf.
  const p = seedPrompt(indexOf(item()), 'plans/2026-01-01-alpha.md');
  assert.match(p, /\/plans claim plans\/2026-01-01-alpha\.md/);
  assert.match(p, /never with --force/);
  assert.match(p, /stop and say so/i);
});

test('the prompt is quoted so model-written prose cannot become shell code', () => {
  // The prompt is model-authored and passes through TWO interpreters — osascript's
  // string, then the shell. A bare backtick or $( ) would otherwise execute.
  const cmd = buildCommand({
    repo: '/tmp/my repo',
    claudeBin: '/usr/bin/claude',
    prompt: "look at `rm -rf /` and $(whoami) and it's fine",
  });
  assert.match(cmd, /^cd '\/tmp\/my repo' && '\/usr\/bin\/claude' '/);
  // No unescaped single quote can terminate the quoting early.
  const promptPart = cmd.slice(cmd.indexOf("'/usr/bin/claude' ") + "'/usr/bin/claude' ".length);
  assert.ok(promptPart.startsWith("'") && promptPart.endsWith("'"));
  assert.ok(!/(?<!\\)'(?!\\'')/.test(promptPart.slice(1, -1).replace(/'\\''/g, '')), 'no bare quote inside');
  assert.ok(cmd.includes("rm -rf"), 'content is preserved, just neutralised');
});

test('the seeded prompt reports task state honestly, including "no checkboxes"', () => {
  const none = seedPrompt(indexOf(item()), 'plans/2026-01-01-alpha.md');
  assert.match(none, /no task checkboxes/);

  const withTasks = seedPrompt(
    indexOf(
      item({
        tasks: [
          { index: 0, line: 1, text: 'a', spoken: 'a', done: true, depth: 0 },
          { index: 1, line: 2, text: 'b', spoken: 'b', done: false, depth: 0 },
        ],
      })
    ),
    'plans/2026-01-01-alpha.md'
  );
  assert.match(withTasks, /1 of 2 tasks are ticked/);
});
