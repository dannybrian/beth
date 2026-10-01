import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand, treeFingerprint, type RunningCommand } from './runCommand.ts';

// --- the process tree ----------------------------------------------------------
//
// Real processes, not a stubbed spawn: the bug was in what the OS does with a
// grandchild whose parent died, and a stub has no grandchildren.

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Poll, never a fixed sleep — how long a SIGKILL takes to land is not ours. */
async function until(cond: () => boolean, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

/**
 * A leader that starts a worker and reports its pid — the shape of `pnpm test`
 * over a vitest pool. The worker ignores SIGTERM, because a pool worker that
 * dies on the first signal would let a leader-only kill pass this test.
 */
function tree(dir: string, leader: string, workerStdio: 'ignore' | 'inherit' = 'ignore') {
  const pidFile = path.join(dir, 'worker.pid');
  const worker = `process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  const script =
    `const {spawn}=require('node:child_process');` +
    `const w=spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'${workerStdio}'});` +
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(w.pid));` +
    leader;
  return { command: [process.execPath, '-e', script], pidFile };
}

const workerPid = async (pidFile: string) => {
  await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0);
  return Number(fs.readFileSync(pidFile, 'utf8'));
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runcmd-'));

/** The 2026-09-13 bug exactly: a timeout killed pnpm and left the pool running. */
test('a timeout takes the WHOLE tree, not just the process it started', async () => {
  const dir = tmp();
  const { command, pidFile } = tree(dir, `setInterval(()=>{},1000)`);
  const run = runCommand({ command, cwd: dir, timeoutMs: 400 });
  const pid = await workerPid(pidFile);
  assert.ok(alive(pid), 'the worker started');
  const result = await run;
  assert.equal(result.timedOut, true);
  assert.ok(await until(() => !alive(pid)), 'the worker outlived the timeout — an orphan');
});

/**
 * pnpm dies promptly on SIGTERM; its workers do not have to. A stop that
 * escalates only while the LEADER lives would call that done.
 */
test('a stop reaches a worker that ignores SIGTERM, after its leader has already gone', async () => {
  const dir = tmp();
  const { command, pidFile } = tree(dir, `setInterval(()=>{},1000)`);
  let handle: RunningCommand | null = null;
  const run = runCommand({ command, cwd: dir, timeoutMs: 60_000, onStart: (h) => (handle = h) });
  const pid = await workerPid(pidFile);
  handle!.stop('SIGTERM');
  await run;
  assert.ok(await until(() => !alive(pid)), 'the worker survived the stop');
});

/**
 * A command that FINISHES but leaves a worker behind still leaves an orphan —
 * and one holding the stdout pipe keeps 'close' from ever firing, so the run
 * would never report at all.
 */
test('a finished command sweeps what it left behind, and still reports', async () => {
  const dir = tmp();
  const { command, pidFile } = tree(dir, `setTimeout(()=>process.exit(0),200)`, 'inherit');
  const result = await runCommand({ command, cwd: dir, timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(await until(() => !alive(pid)), 'the straggler was left running');
});

// --- the fingerprint -------------------------------------------------------------

function repo() {
  const dir = fs.realpathSync(tmp());
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'plans'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'plans', '2026-09-13-x.md'), '---\nstatus: active\n---\n');
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export {}\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return { dir, git };
}

/**
 * beadgame's hook heartbeats plan frontmatter after every turn, and its sessions
 * commit plans constantly. Neither is a change to anything a suite reads, and
 * treating them as one ran the monorepo suite every two minutes all morning.
 */
test('plan churn — edited, then committed — is not a change', () => {
  const { dir, git } = repo();
  const quiet = [path.join(dir, 'plans')];
  const before = treeFingerprint(dir, quiet);
  assert.ok(before);
  fs.writeFileSync(path.join(dir, 'plans', '2026-09-13-x.md'), '---\nstatus: active\nupdated: now\n---\n');
  assert.equal(treeFingerprint(dir, quiet), before, 'a heartbeat moved the fingerprint');
  git('commit', '-qam', 'docs(plans): tick');
  assert.equal(treeFingerprint(dir, quiet), before, 'a plans-only commit moved the fingerprint');
});

test('...while code still is, uncommitted and committed alike', () => {
  const { dir, git } = repo();
  const quiet = [path.join(dir, 'plans')];
  const before = treeFingerprint(dir, quiet);
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const x = 1\n');
  const edited = treeFingerprint(dir, quiet);
  assert.notEqual(edited, before);
  git('commit', '-qam', 'code');
  assert.notEqual(treeFingerprint(dir, quiet), before);
});

test('with nothing quiet, a plan edit is a change as it always was', () => {
  const { dir } = repo();
  const before = treeFingerprint(dir);
  fs.writeFileSync(path.join(dir, 'plans', '2026-09-13-x.md'), 'changed\n');
  assert.notEqual(treeFingerprint(dir), before);
});

/** Git names paths from the toplevel; a harness bound below it must still match. */
test('quiet roots still match when the harness is bound to a subdirectory', () => {
  const { dir } = repo();
  const sub = path.join(dir, 'src');
  const quiet = [path.join(dir, 'plans')];
  const before = treeFingerprint(sub, quiet);
  fs.writeFileSync(path.join(dir, 'plans', '2026-09-13-x.md'), 'changed\n');
  assert.equal(treeFingerprint(sub, quiet), before);
});

test('not a git repo is NO OPINION, never a value', () => {
  assert.equal(treeFingerprint(tmp()), '');
});
