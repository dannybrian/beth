import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectBuild, BuildRunner, type BuildState } from './buildRunner.ts';
import { ConversationBus } from './bus.ts';
import type { HarnessConfig } from './config.ts';

const tmp = (files: Record<string, string> = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
};

const pkg = (o: Record<string, unknown>) => JSON.stringify(o);

// --- detection ---------------------------------------------------------------

test('the package manager comes from what the project DECLARES', () => {
  const dir = tmp({ 'package.json': pkg({ packageManager: 'pnpm@9.1.0', scripts: { build: 'tsc' } }) });
  assert.deepEqual(detectBuild(dir)?.command, ['pnpm', 'run', 'build']);
});

test('`run` is always spelled out — `npm build` is not a command', () => {
  const dir = tmp({ 'package.json': pkg({ scripts: { build: 'webpack' } }) });
  const d = detectBuild(dir);
  assert.deepEqual(d?.command, ['npm', 'run', 'build']);
  assert.match(d!.why, /scripts\.build \(npm\)/);
});

test('...and falls back to the lockfile', () => {
  const dir = tmp({ 'package.json': pkg({ scripts: { build: 'tsc' } }), 'yarn.lock': '' });
  assert.deepEqual(detectBuild(dir)?.command, ['yarn', 'run', 'build']);
});

test('a package.json with only a TEST script is not a build', () => {
  const dir = tmp({ 'package.json': pkg({ scripts: { test: 'node --test' } }) });
  assert.equal(detectBuild(dir), null);
});

test('the other ecosystems, each by the file that names them', () => {
  assert.deepEqual(detectBuild(tmp({ 'Cargo.toml': '' }))?.command, ['cargo', 'build']);
  assert.deepEqual(detectBuild(tmp({ 'go.mod': '' }))?.command, ['go', 'build', './...']);
  assert.deepEqual(detectBuild(tmp({ 'app.csproj': '' }))?.command, ['dotnet', 'build']);
  assert.deepEqual(detectBuild(tmp({ Makefile: 'build:\n\tcc x.c\n' }))?.command, ['make', 'build']);
});

test('a Makefile without a build target is not a build', () => {
  assert.equal(detectBuild(tmp({ Makefile: 'test:\n\tpytest\n' })), null);
});

/**
 * The refusal that matters most. A `dev` or `start` script is the obvious thing
 * to reach for in a repo with no build, and it is exactly wrong: it never exits,
 * so the light sticks on yellow until the timeout kills the server.
 */
test('a repo with only a dev script gets NOTHING, never a server', () => {
  const dir = tmp({ 'package.json': pkg({ scripts: { dev: 'vite', start: 'node server.js' } }) });
  assert.equal(detectBuild(dir), null);
});

test('a repo the detectors do not recognise gets nothing', () => {
  assert.equal(detectBuild(tmp({ 'README.md': '# hi' })), null);
});

test('HARNESS_BUILD_CMD beats every detector, and never reaches a shell', () => {
  const dir = tmp({ 'Cargo.toml': '' });
  const d = detectBuild(dir, '  make  release && rm -rf /  ');
  // Split on whitespace, so `&&` is an ARGUMENT to make rather than an operator.
  assert.deepEqual(d?.command, ['make', 'release', '&&', 'rm', '-rf', '/']);
  assert.equal(d?.why, 'HARNESS_BUILD_CMD');
});

// --- running -----------------------------------------------------------------

const cfgFor = (repo: string, cmd: string, buildTimeoutMs = 10_000) =>
  ({ repo, buildCmd: cmd, buildTimeoutMs }) as unknown as HarnessConfig;

/** Every `build` state the bus saw, in order. */
function watched(bus: ConversationBus): BuildState[] {
  const seen: BuildState[] = [];
  bus.subscribe((m) => {
    if (m.type === 'build') seen.push(m.state);
  });
  return seen;
}

test('a build that passes goes green, and says so on the bus', async () => {
  const bus = new ConversationBus();
  const seen = watched(bus);
  const b = new BuildRunner(cfgFor(tmp(), 'node -e process.stdout.write("built")'), bus);
  await b.run();
  assert.deepEqual(
    seen.map((s) => s.light),
    ['yellow', 'green']
  );
  assert.equal(b.state().last?.exitCode, 0);
  assert.equal(b.state().last?.output, 'built');
  assert.equal(b.state().stale, false);
});

test('a build that fails goes red and keeps what it printed', async () => {
  const bus = new ConversationBus();
  const b = new BuildRunner(cfgFor(tmp(), 'node -e console.error("TS2304");process.exit(2)'), bus);
  await b.run();
  const s = b.state();
  assert.equal(s.light, 'red');
  assert.equal(s.last?.exitCode, 2);
  assert.match(s.last!.output, /TS2304/);
});

test('a command that will not start is a failure, not a throw', async () => {
  const bus = new ConversationBus();
  const b = new BuildRunner(cfgFor(tmp(), 'definitely-not-a-real-binary-xyz'), bus);
  await b.run();
  assert.equal(b.state().light, 'red');
  assert.equal(b.state().last?.exitCode, null);
});

test('a build that outruns the timeout is killed and REPORTED, not left hanging', async () => {
  const bus = new ConversationBus();
  const b = new BuildRunner(cfgFor(tmp(), 'node -e setTimeout(()=>{},60000)', 150), bus);
  await b.run();
  const s = b.state();
  assert.equal(s.last?.timedOut, true);
  assert.equal(s.light, 'red');
});

/**
 * A stop is not a failure. Reporting it red would make the strip claim something
 * is broken because you changed your mind — the same distinction the transcript
 * already makes for a stopped turn.
 */
test('a build you cancelled reads as no news, not as broken', async () => {
  const bus = new ConversationBus();
  const b = new BuildRunner(cfgFor(tmp(), 'node -e setTimeout(()=>{},60000)'), bus);
  const done = b.run();
  // The child exists only once the run has actually spawned it.
  while (!b.state().running) await new Promise((r) => setTimeout(r, 5));
  b.cancel();
  await done;
  const s = b.state();
  assert.equal(s.last?.cancelled, true);
  assert.equal(s.light, 'grey');
});

test('a second run while one is in flight is refused, not queued', async () => {
  const bus = new ConversationBus();
  const seen = watched(bus);
  const b = new BuildRunner(cfgFor(tmp(), 'node -e process.exit(0)'), bus);
  const first = b.run();
  await b.run(); // returns at once; the first is still going
  await first;
  assert.deepEqual(
    seen.map((s) => s.light),
    ['yellow', 'green']
  );
});

// --- staleness ---------------------------------------------------------------

/**
 * The fingerprint is injected here for the same reason the credit meter injects
 * its exhaustion check: the real one shells out to git, and what is worth
 * testing is what the light does when the answer CHANGES.
 */
test('a green build goes yellow once the tree moves under it', async () => {
  const bus = new ConversationBus();
  const seen = watched(bus);
  let tree = 'aaa';
  const b = new BuildRunner(cfgFor(tmp(), 'node -e process.exit(0)'), bus, {
    fingerprint: () => tree,
    stalePollMs: 5,
  });
  await b.run();
  assert.equal(b.state().light, 'green');
  tree = 'bbb';
  // Poll for it rather than sleeping a fixed amount — see CLAUDE.md.
  while (!b.state().stale) await new Promise((r) => setTimeout(r, 5));
  assert.equal(b.state().light, 'yellow');
  // And it is announced, or the strip would go on claiming green until something
  // else happened to publish.
  assert.deepEqual(
    seen.map((s) => s.light),
    ['yellow', 'green', 'yellow']
  );
  b.stop();
});

test('the staleness watch stops once it has fired — stale cannot get staler', async () => {
  const bus = new ConversationBus();
  const seen = watched(bus);
  let tree = 'aaa';
  const b = new BuildRunner(cfgFor(tmp(), 'node -e process.exit(0)'), bus, {
    fingerprint: () => tree,
    stalePollMs: 5,
  });
  await b.run();
  tree = 'bbb';
  while (!b.state().stale) await new Promise((r) => setTimeout(r, 5));
  const after = seen.length;
  tree = 'ccc';
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(seen.length, after, 'the tree moving again is not news');
  b.stop();
});

/**
 * '' is "we could not tell" — not a git repo, or git is unhappy. Two of those
 * compare EQUAL, so a watch started on one would poll forever announcing
 * nothing, and `stale` would be a claim we are in no position to make.
 */
test('a repo git cannot read is never watched, and never claims staleness', async () => {
  const bus = new ConversationBus();
  const b = new BuildRunner(cfgFor(tmp(), 'node -e process.exit(0)'), bus, {
    fingerprint: () => '',
    stalePollMs: 5,
  });
  await b.run();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(b.state().stale, false);
  assert.equal(b.state().light, 'green');
});

test('nothing detected is grey and inert — run() does not spawn a guess', async () => {
  const bus = new ConversationBus();
  const seen = watched(bus);
  const b = new BuildRunner({ repo: tmp(), buildTimeoutMs: 1000 } as unknown as HarnessConfig, bus);
  await b.run();
  assert.equal(b.state().light, 'grey');
  assert.equal(b.state().command, null);
  assert.deepEqual(seen, []);
});
