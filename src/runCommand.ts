// Running one of the project's OWN commands, and remembering how it went.
//
// Shared by the test monitor and the build button, which want the same three
// things — spawn what the project declares, keep the tail, never leave a process
// behind — and differ in the thing that actually matters: WHEN they fire. Tests
// run themselves on a schedule, which is why they are gated behind an explicit
// enable; a build only ever runs because someone asked for it, so the click is
// the authorisation and there is no gate to keep.
//
// ⚠️ Nothing here reaches a shell. The command is argv, spawned directly, so a
// command that genuinely needs shell syntax should be a script the project has.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Output beyond this is the tail of something that has already gone wrong. */
export const MAX_OUTPUT = 256 * 1024;

export type CommandResult = {
  /** When it FINISHED — the light is about the last answer, not the last start. */
  at: number;
  ms: number;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
};

export async function runCommand(opts: {
  command: string[];
  cwd: string;
  timeoutMs: number;
  maxOutput?: number;
  /** The caller holds the child, so a stop button and shutdown can reach it. */
  onStart?: (child: ChildProcess) => void;
}): Promise<CommandResult> {
  const cap = opts.maxOutput ?? MAX_OUTPUT;
  const [cmd, ...args] = opts.command;
  const t0 = Date.now();
  let out = '';
  let timedOut = false;

  const exitCode = await new Promise<number | null>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
      });
    } catch {
      out = `could not start ${cmd}`;
      return resolve(null);
    }
    opts.onStart?.(child);
    const take = (b: Buffer) => {
      // Keep the TAIL: a run that fails late buries the reason otherwise.
      out = (out + b.toString()).slice(-cap);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('error', (e) => {
      out += `\n${String(e)}`;
      resolve(null);
    });
    const kill = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // A command that ignores SIGTERM must not become a process that outlives
      // the harness. Reported as timed out rather than left hanging.
      setTimeout(() => child.kill('SIGKILL'), 3000).unref?.();
    }, opts.timeoutMs);
    kill.unref?.();
    child.on('close', (c) => {
      clearTimeout(kill);
      resolve(c);
    });
  });

  const at = Date.now();
  return { at, ms: at - t0, exitCode, timedOut, output: out };
}

/**
 * What the tree looks like right now.
 *
 * `git status --short` alone is not enough: editing an already-modified file a
 * second time does not change its output. So the mtimes of the changed files
 * come along, and HEAD too, so a commit or a checkout counts as a change.
 *
 * ⚠️ '' means we could not tell — not a git repo, or git is unhappy. Every
 * caller must treat that as "no opinion" rather than as a value, because two
 * empty fingerprints compare EQUAL and that reads as "nothing has changed".
 */
export function treeFingerprint(repo: string): string {
  try {
    // stderr ignored, not inherited: this runs every few seconds, and in a
    // directory git does not own it would otherwise print "not a git repository"
    // into the harness log forever. The catch below is the answer we want.
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    const status = git(['status', '--porcelain']);
    const head = git(['rev-parse', 'HEAD']).trim();
    const mtimes = status
      .split('\n')
      .map((l) => l.slice(3).trim().split(' -> ').pop())
      .filter(Boolean)
      .map((f) => {
        try {
          return String(fs.statSync(path.join(repo, f!)).mtimeMs);
        } catch {
          return 'x';
        }
      });
    return crypto.createHash('sha1').update(`${head}\n${status}\n${mtimes.join(',')}`).digest('hex');
  } catch {
    return '';
  }
}
