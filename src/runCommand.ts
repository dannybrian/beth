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

/**
 * A command in flight, as the caller may touch it: a stop, never the child.
 *
 * ⚠️ Handing out the ChildProcess is how the orphans happened. `child.kill()`
 * signals ONE pid, and a project's test command is almost never one process —
 * beadgame's `pnpm test` is pnpm, then `pnpm -r`, then a vitest pool of eight
 * forks. Killing pnpm left the pool running, reparented to launchd at 15–30%
 * CPU each, and the next scheduled run stacked a second pool on top until the
 * machine stopped answering (2026-09-13). So the command runs as the leader of
 * its OWN process group and every signal here goes to the group.
 */
export type RunningCommand = {
  pid: number;
  /** Signal the whole tree. SIGTERM escalates to SIGKILL if anything is still there. */
  stop(signal?: NodeJS.Signals): void;
};

/** How long a SIGTERM is given before the group is SIGKILLed. */
const GRACE_MS = 3000;

/**
 * Groups still alive, for the exit backstop below. A group is removed once its
 * leader has exited and the sweep has run.
 */
const live = new Set<number>();
let backstop = false;

/** Signal a process group. Gone already is the answer we wanted, not an error. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    /* ESRCH: nothing left in the group */
  }
}

export async function runCommand(opts: {
  command: string[];
  cwd: string;
  timeoutMs: number;
  maxOutput?: number;
  /** The caller holds the handle, so a stop button and shutdown can reach it. */
  onStart?: (run: RunningCommand) => void;
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
        // Its own process group (setsid), so the group can be signalled as one.
        // ⚠️ Which also takes it out of the terminal's group: a Ctrl-C no longer
        // reaches it on its own, so shutdown MUST stop it — the exit backstop
        // below is what makes that true on every way out, not just a clean one.
        detached: true,
      });
    } catch {
      out = `could not start ${cmd}`;
      return resolve(null);
    }
    const pid = child.pid;
    if (pid === undefined) {
      // spawn failed asynchronously (ENOENT); 'error' below reports it.
      child.on('error', (e) => {
        out += `\n${String(e)}`;
        resolve(null);
      });
      return;
    }
    live.add(pid);
    if (!backstop) {
      backstop = true;
      // Synchronous, so it survives `process.exit` — which is how /restart and
      // every shutdown path leave. A harness that exits must not leave a suite
      // running with nobody left to read its light.
      process.on('exit', () => {
        for (const g of live) signalGroup(g, 'SIGKILL');
      });
    }

    let exited = false;
    const stop = (signal: NodeJS.Signals = 'SIGTERM') => {
      signalGroup(pid, signal);
      if (signal !== 'SIGKILL') {
        // Escalate on the GROUP, not on the leader's exit: pnpm dying promptly
        // on SIGTERM says nothing about the workers under it.
        setTimeout(() => live.has(pid) && signalGroup(pid, 'SIGKILL'), GRACE_MS).unref?.();
      }
    };
    opts.onStart?.({ pid, stop });

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
      // A command that ignores SIGTERM must not become a process that outlives
      // the harness. Reported as timed out rather than left hanging.
      stop('SIGTERM');
    }, opts.timeoutMs);
    kill.unref?.();
    child.on('exit', () => {
      exited = true;
      // The leader is done, so anything still in its group is an orphan by
      // definition — a worker the runner forgot, or one a stop only half-reached.
      // Swept on EXIT rather than on close: an orphan holding the stdout pipe
      // keeps 'close' from ever firing, and the light would sit on yellow.
      signalGroup(pid, 'SIGKILL');
      live.delete(pid);
    });
    child.on('close', (c) => {
      clearTimeout(kill);
      if (!exited) live.delete(pid);
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
 * come along, and the INDEX too, so a commit, a checkout or a pull counts as a
 * change.
 *
 * `quiet` names directories whose churn is not a change to anything a test or a
 * build reads — the plan corpus, in practice. ⚠️ It exists because a repo that
 * writes to itself on every turn never sits still: beadgame's plans-tick hook
 * heartbeats plan frontmatter after each turn and its sessions commit plans
 * constantly, so every settle looked like an edit and the full monorepo suite
 * launched every `testMinIntervalMs` for as long as the conversation lasted.
 * The index listing (`ls-files -s`, filtered) replaces HEAD for the same reason:
 * HEAD moves on a plans-only commit, and the blobs that matter do not.
 *
 * ⚠️ '' means we could not tell — not a git repo, or git is unhappy. Every
 * caller must treat that as "no opinion" rather than as a value, because two
 * empty fingerprints compare EQUAL and that reads as "nothing has changed".
 */
export function treeFingerprint(repo: string, quiet: string[] = []): string {
  try {
    // stderr ignored, not inherited: this runs every few seconds, and in a
    // directory git does not own it would otherwise print "not a git repository"
    // into the harness log forever. The catch below is the answer we want.
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        timeout: 4000,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    // Both listings below name paths from the TOPLEVEL, which is not `repo` when
    // the harness is bound to a subdirectory — so the quiet roots are too.
    const top = git(['rev-parse', '--show-toplevel']).trim();
    const prefixes = quiet.map((q) => {
      const r = path.relative(top, realpath(q)).split(path.sep).join('/');
      return r + '/';
    });
    const loud = (p: string) => !prefixes.some((q) => p.startsWith(q));

    const status = git(['status', '--porcelain'])
      .split('\n')
      .filter((l) => l && loud(l.slice(3).trim().split(' -> ').pop()!));
    const index = git(['ls-files', '-s', '--full-name', ':/'])
      .split('\n')
      // `<mode> <blob> <stage>\t<path>`
      .filter((l) => l && loud(l.slice(l.indexOf('\t') + 1)));
    const mtimes = status
      .map((l) => l.slice(3).trim().split(' -> ').pop())
      .map((f) => {
        try {
          return String(fs.statSync(path.join(top, f!)).mtimeMs);
        } catch {
          return 'x';
        }
      });
    return crypto
      .createHash('sha1')
      .update(`${index.join('\n')}\n${status.join('\n')}\n${mtimes.join(',')}`)
      .digest('hex');
  } catch {
    return '';
  }
}

const realpath = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
