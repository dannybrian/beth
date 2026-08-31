import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Settings } from './settings.ts';
import { BuildRunner } from './buildRunner.ts';
import { TestMonitor } from './testRunner.ts';
import { ConversationBus } from './bus.ts';
import type { HarnessConfig } from './config.ts';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));

test('a setting survives the restart it exists for', () => {
  const stateDir = dir();
  new Settings({ stateDir }).set('buildCmd', 'cargo build --release');
  assert.equal(new Settings({ stateDir }).get('buildCmd'), 'cargo build --release');
});

test('clearing is a real gesture — it hands the command back', () => {
  const stateDir = dir();
  const s = new Settings({ stateDir });
  s.set('testCmd', 'bin/ci');
  assert.deepEqual(s.set('testCmd', ''), {});
  assert.equal(new Settings({ stateDir }).get('testCmd'), undefined);
});

test('whitespace is not a setting', () => {
  const s = new Settings({ stateDir: dir() });
  s.set('testCmd', '   ');
  assert.equal(s.get('testCmd'), undefined);
});

test('a file we cannot read starts empty rather than throwing', () => {
  const stateDir = dir();
  fs.writeFileSync(path.join(stateDir, 'settings.json'), '{ this is not json');
  assert.deepEqual(new Settings({ stateDir }).all(), {});
});

test('a state dir we cannot write does not fail the click', () => {
  const s = new Settings({ stateDir: path.join(dir(), 'nope', 'deeper') });
  s.set('buildCmd', 'make');
  // It applies to the running harness; it just will not survive a restart.
  assert.equal(s.get('buildCmd'), 'make');
});

// --- what the precedence rule is FOR -----------------------------------------

const cfgFor = (repo: string, extra: Partial<HarnessConfig> = {}) =>
  ({ repo, buildTimeoutMs: 5000, testTimeoutMs: 5000, stateDir: repo, ...extra }) as unknown as HarnessConfig;

const repoWith = (files: Record<string, string>) => {
  const d = dir();
  for (const [n, body] of Object.entries(files)) fs.writeFileSync(path.join(d, n), body);
  return d;
};

/**
 * The page's setting wins over the env layer, and the panel is told WHICH won.
 * The alternative — env first — makes a value you typed silently do nothing
 * whenever the repo happens to set one, which is a no-op with no symptom.
 */
test('what the page set beats HARNESS_BUILD_CMD, and says so', () => {
  const repo = repoWith({ 'Cargo.toml': '' });
  const settings = new Settings({ stateDir: repo });
  settings.set('buildCmd', 'make release');
  const b = new BuildRunner(cfgFor(repo, { buildCmd: 'cargo build' }), new ConversationBus(), { settings });
  assert.deepEqual(b.state().command, ['make', 'release']);
  assert.equal(b.state().why, 'set here');
});

test('...and clearing it falls back to the env layer, then to detection', () => {
  const repo = repoWith({ 'Cargo.toml': '' });
  const settings = new Settings({ stateDir: repo });
  settings.set('buildCmd', 'make release');
  const cfg = cfgFor(repo, { buildCmd: 'cargo build --release' });
  const b = new BuildRunner(cfg, new ConversationBus(), { settings });

  b.setCommand('');
  assert.deepEqual(b.state().command, ['cargo', 'build', '--release']);
  assert.equal(b.state().why, 'HARNESS_BUILD_CMD');

  // And with no env layer either, whatever the repo declares.
  const bare = new BuildRunner(cfgFor(repo), new ConversationBus(), { settings });
  assert.deepEqual(bare.state().command, ['cargo', 'build']);
  assert.equal(bare.state().why, 'Cargo.toml');
});

/**
 * The light belongs to the command that earned it. Keeping a green one across a
 * command change would read exactly like the NEW command having passed.
 */
test('a new build command drops the light the old one earned', async () => {
  const repo = repoWith({});
  const settings = new Settings({ stateDir: repo });
  const b = new BuildRunner(cfgFor(repo, { buildCmd: 'node -e process.exit(0)' }), new ConversationBus(), {
    settings,
  });
  await b.run();
  assert.equal(b.state().light, 'green');
  b.setCommand('node -e process.exit(1)');
  assert.equal(b.state().last, null);
  assert.equal(b.state().light, 'grey');
});

test('a new test command drops the failures the old one found', async () => {
  // A real failing run, from a script rather than `node -e`: the command is
  // split on whitespace, so anything with a space in it is several arguments.
  const repo = repoWith({ 'fail.js': 'console.log("not ok 1 - the settle window");process.exit(1);' });
  const settings = new Settings({ stateDir: repo });
  const t = new TestMonitor(cfgFor(repo, { testCmd: 'node fail.js' }), new ConversationBus(), settings);
  await t.run();
  assert.deepEqual(
    t.state().last?.failures.map((f) => f.spoken),
    ['the settle window']
  );
  t.setCommand('bin/ci');
  assert.deepEqual(t.state().command, ['bin/ci']);
  assert.equal(t.state().why, 'set here');
  // Those failures name tests the replaced command was running; clicking one
  // would point her at something nothing here can reproduce.
  assert.equal(t.state().last, null);
});
