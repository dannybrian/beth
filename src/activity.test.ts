import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { summarizeTool } from './activity.ts';

const REPO = '/Users/dbrian/Sources/beadgame';
const sum = (name: string, input: Record<string, unknown>) => summarizeTool(name, input, REPO);

// The line that started this, straight out of the transcript: three wrapped
// lines of JSON whose useful content was one filename.
test('a file path is shown the way he thinks of it', () => {
  assert.equal(sum('Write', { file_path: `${REPO}/plans/2026-07-15-viz.md`, content: 'hello' }), 'write plans/2026-07-15-viz.md');
  assert.equal(sum('Read', { file_path: `${REPO}/src/voice.ts` }), 'read src/voice.ts');
  assert.equal(sum('Edit', { file_path: `${REPO}/ui/app.js`, replace_all: true }), 'edit ui/app.js (all)');
});

test('a path outside the repo keeps its shape, with home as ~', () => {
  assert.equal(sum('Read', { file_path: `${os.homedir()}/.director-harness/.env` }), 'read ~/.director-harness/.env');
  assert.equal(sum('Read', { file_path: '/etc/hosts' }), 'read /etc/hosts');
});

test('a read with a window says which window', () => {
  assert.equal(sum('Read', { file_path: `${REPO}/a.md`, offset: 40, limit: 20 }), 'read a.md:40+20');
});

// Her description is a paraphrase; the command is what ran.
test('bash shows the command, not the description', () => {
  assert.equal(sum('Bash', { command: 'pnpm test', description: 'Run the suite' }), 'run pnpm test');
  assert.equal(sum('Bash', { command: 'sleep 25', run_in_background: true }), 'run sleep 25 &');
  assert.match(sum('Bash', { description: 'List files' }), /^run List files$/, 'falls back when there is no command');
});

// The repo path inside the command is what actually wrapped in practice.
test('a command spelling out the repo path is collapsed to a dot', () => {
  assert.equal(sum('Bash', { command: `git -C ${REPO} status --short` }), 'run git -C . status --short');
  assert.equal(sum('Bash', { command: `grep -r scratch ${REPO}/src` }), 'run grep -r scratch ./src');
  assert.equal(sum('Bash', { command: `cat ${os.homedir()}/.zshrc` }), 'run cat ~/.zshrc');
});

test('searches name what is being looked for and where', () => {
  assert.equal(sum('Grep', { pattern: 'speakable', path: `${REPO}/src` }), 'grep speakable in src');
  assert.equal(sum('Glob', { pattern: '**/*.ts' }), 'glob **/*.ts');
});

test('work handed off names the work', () => {
  assert.equal(sum('Task', { description: 'Build the drift check', subagent_type: 'general-purpose' }), 'dispatch Build the drift check');
  assert.equal(sum('Skill', { skill: 'plans', args: 'status shipped' }), '/plans status shipped');
});

// Her own tools carry the harness prefix, which is never the interesting part.
test('an MCP tool loses its server prefix and shows its arguments', () => {
  assert.equal(sum('mcp__harness__plans', { scope: 'in-flight', tasks: true }), 'plans scope=in-flight tasks=true');
  assert.equal(sum('mcp__harness__pending', {}), 'pending');
});

test('an unknown tool still produces something readable', () => {
  assert.equal(sum('SomeNewTool', { target: 'x', count: 3 }), 'SomeNewTool target=x count=3');
  assert.equal(sum('SomeNewTool', {}), 'SomeNewTool');
});

test('long arguments are clipped rather than allowed to wrap', () => {
  const line = sum('Bash', { command: 'x'.repeat(400) });
  assert.ok(line.length <= 78, `too long: ${line.length}`);
  assert.match(line, /…$/);
});

// A transcript entry must never be the thing that breaks the transcript.
test('a malformed input is survivable', () => {
  assert.equal(sum('Read', {}), 'read');
  assert.equal(sum('Read', { file_path: 42 as never }), 'read');
  assert.equal(sum('WebFetch', { url: 'not a url' }), 'fetch not a url');
  assert.equal(sum('TodoWrite', { todos: 'nope' as never }), 'todos (0)');
});
