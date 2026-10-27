// Run it — the project's app, started and stopped from the page (docs/run.md).
//
// The third runner, and the odd one out: the test and build lights run things
// that END and report how they ended. This one starts something that is meant
// to keep going, and its question is not "did it pass" but "is it up, and where".
//
// ⚠️ The harness REMEMBERS NOTHING about a run. It restarts several times a day,
// and the app may have been started from a terminal or by a worker, so a pid it
// held would be wrong exactly when it mattered. The project declares where its
// app answers (HARNESS_RUN_URL, or the gear), and whether it is up is read off
// that PORT every time. The one thing kept is the log of a start made here, which
// is for reading, never for knowing state.
//
// ⚠️ Nothing is signalled on a guess. A listener on the port is this project's
// only if its working directory is inside the repo, and so is every process in
// its group — the group, not the pid, because elvidrio's `dev` is `node --watch`
// and the listener is the CHILD: kill only it and the watcher lives on, holding
// nothing, and starts it again on the next save. Same standard as /api/image:
// act only on what can be proved.
//
// Like the build, nothing here fires on its own — a press is the authorisation.
// If this ever grows an auto-start, it needs the test monitor's enable gate.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import type { HarnessConfig } from './config.ts';
import type { ConversationBus } from './bus.ts';
import type { Settings } from './settings.ts';
import type { Workbench } from './workbench.ts';
import { vetBenchUrl } from './workbench.ts';
import { packageManager } from './buildRunner.ts';

const run = promisify(execFile);

export type RunPhase =
  /** Nothing answering, nothing of ours alive. */
  | 'stopped'
  /** Ours, alive, and its port not answering yet. */
  | 'starting'
  | 'running'
  | 'stopping'
  /** Ours, and it exited without being asked to. The red light. */
  | 'crashed'
  /** Something answers on the port that cannot be proved to be this project's. */
  | 'taken';

export type RunState = {
  /** argv, never a shell string — same rule as the other two runners. */
  command: string[] | null;
  why: string | null;
  url: string | null;
  /** Where the url came from: a declaration, or what the app printed. */
  urlWhy: string | null;
  phase: RunPhase;
  /** This harness process started what is running, so the log is this run's. */
  owned: boolean;
  /** The sentence the light's tooltip needs: who holds the port, why a start is slow. */
  note: string | null;
  exit: { code: number | null; signal: string | null; at: number } | null;
  /** When the log on disk was started, or null when there is none. */
  logAt: number | null;
};

/**
 * What this project calls running, or nothing.
 *
 * The scripts the build REFUSES — `dev`, then `start` — because they never end,
 * which is this runner's whole job. Nothing else is guessed: a repo with neither
 * declares HARNESS_RUN_CMD (talktree's server lives in a package, not the root).
 */
export function detectRun(
  repo: string,
  override?: string,
  overrideWhy = 'HARNESS_RUN_CMD'
): { command: string[]; why: string } | null {
  if (override?.trim()) return { command: override.trim().split(/\s+/), why: overrideWhy };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
    for (const script of ['dev', 'start']) {
      if (pkg?.scripts?.[script]) {
        const pm = packageManager(repo, pkg);
        return { command: [pm, 'run', script], why: `package.json scripts.${script} (${pm})` };
      }
    }
  } catch {
    /* no package.json, or one that declares nothing */
  }
  return null;
}

/**
 * The app's own address, out of what it printed.
 *
 * The FIRST local http url — loopback hosts only. All three apps this was built
 * for print one in their banner, and the rule is shaped by their real output
 * (src/fixtures/run/): appresent2 prints its display before a LAN controller url,
 * and elvidrio names Ollama's `127.0.0.1:11434` further down, which is somebody
 * else's server. First wins; a LAN address is never the one to probe.
 */
export function sniffUrl(output: string): string | null {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
  const m = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):\d+[^\s'"<>)\]]*/.exec(plain);
  if (!m) return null;
  // 0.0.0.0 is a bind address, not somewhere a browser goes.
  const url = m[0].replace(/[.,;:]+$/, '').replace('//0.0.0.0:', '//127.0.0.1:');
  const v = vetBenchUrl(url);
  return v.ok ? v.url : null;
}

export function portOf(url: string): number | null {
  try {
    const u = new URL(url);
    const p = Number(u.port || (u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : NaN));
    return Number.isInteger(p) && p > 0 && p < 65536 ? p : null;
  } catch {
    return null;
  }
}

/**
 * Is anything listening there. Both loopbacks: `localhost` is `::1` first on this
 * Mac, and elvidrio binds 127.0.0.1 only — a probe of one would call the other
 * stopped.
 */
export function probe(port: number, timeoutMs = 400): Promise<boolean> {
  const one = (host: string) =>
    new Promise<boolean>((resolve) => {
      const s = net.connect({ host, port });
      const done = (up: boolean) => {
        s.destroy();
        resolve(up);
      };
      s.setTimeout(timeoutMs, () => done(false));
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
    });
  return Promise.all([one('127.0.0.1'), one('::1')]).then(([a, b]) => a || b);
}

// --- who holds the port -------------------------------------------------------

const quietly = async (cmd: string, args: string[]): Promise<string> => {
  try {
    return (await run(cmd, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch (e) {
    // lsof exits 1 when it finds nothing, which is an answer, not a failure.
    return (e as { stdout?: string }).stdout ?? '';
  }
};

async function listenersOn(port: number): Promise<number[]> {
  const out = await quietly('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  return [...new Set(out.split('\n').map(Number).filter((n) => n > 0))];
}

async function cwdsOf(pids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (!pids.length) return map;
  const out = await quietly('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')]);
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) map.set(pid, line.slice(1));
  }
  return map;
}

/** Every live process in a group. `ps -A` rather than `-g`: their flags differ across BSD and GNU. */
async function membersOf(pgid: number): Promise<number[]> {
  const out = await quietly('ps', ['-A', '-o', 'pid=,pgid=']);
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([pid, g]) => pid > 0 && g === pgid)
    .map(([pid]) => pid);
}

async function pgidOf(pid: number): Promise<number | null> {
  const n = Number((await quietly('ps', ['-o', 'pgid=', '-p', String(pid)])).trim());
  return n > 0 ? n : null;
}

async function commandOf(pid: number): Promise<string> {
  return (await quietly('ps', ['-o', 'command=', '-p', String(pid)])).trim();
}

const realpath = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

export type Holder =
  | { kind: 'none' }
  | { kind: 'ours'; pid: number; pgid: number }
  | { kind: 'foreign'; pid: number; reason: string };

/**
 * Whose app is answering on `port`.
 *
 * ⚠️ `ours` is a licence to SIGTERM a process group, so it is granted only when
 * every member of that group is working inside the repo, and never for the
 * harness's own group. A group that reaches outside (a shell's job, another
 * project) is reported, not signalled — "stop it where it was started".
 */
export async function attribute(repo: string, port: number): Promise<Holder> {
  const root = realpath(repo);
  const inside = (dir: string | undefined) => {
    if (!dir) return false;
    const d = realpath(dir);
    return d === root || d.startsWith(root + path.sep);
  };
  const pids = await listenersOn(port);
  if (!pids.length) return { kind: 'none' };
  const pid = pids[0];
  const cwds = await cwdsOf(pids);
  if (!inside(cwds.get(pid))) {
    return { kind: 'foreign', pid, reason: `port ${port} is held by \`${await commandOf(pid)}\`, which is not this project` };
  }
  const pgid = await pgidOf(pid);
  const own = await pgidOf(process.pid);
  if (!pgid || pgid === own) return { kind: 'foreign', pid, reason: `port ${port} is held inside the harness's own process group` };
  const members = await membersOf(pgid);
  const memberCwds = await cwdsOf(members);
  const outside = members.filter((m) => !inside(memberCwds.get(m)));
  if (outside.length) {
    return {
      kind: 'foreign',
      pid,
      reason: `port ${port} is this project's, but its process group also holds \`${await commandOf(outside[0])}\` — stop it where it was started`,
    };
  }
  return { kind: 'ours', pid, pgid };
}

function signalGroup(pgid: number, signal: NodeJS.Signals) {
  if (pgid <= 1) return;
  try {
    process.kill(-pgid, signal);
  } catch {
    /* ESRCH: already gone, which is what we wanted */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- the runner -----------------------------------------------------------------

/** How long a SIGTERMed group gets before SIGKILL. A dev server flushing a write needs a moment. */
const GRACE_MS = 5000;
/** A start that has not answered by now gets a note saying so — usually a wrong url. */
const SLOW_START_MS = 30_000;

export class AppRunner {
  private cfg: Pick<HarnessConfig, 'repo' | 'stateDir' | 'runCmd' | 'runUrl'>;
  private bus: Pick<ConversationBus, 'publish'>;
  private bench?: Workbench;
  private settings?: Settings;
  private pollMs: number;
  private logFile: string;

  private detected: { command: string[]; why: string } | null;
  /** The app started here, while it lives. Null after a harness restart, by design. */
  private child: { proc: ChildProcess; pgid: number; startedAt: number } | null = null;
  /** What this run printed as its address — for this run only (see sniffUrl). */
  private learned: string | null = null;
  private exit: RunState['exit'] = null;
  private stopping = false;
  private holder: Holder = { kind: 'none' };
  /** The holder is re-proved when the port comes UP, not on every tick: lsof is not free. */
  private wasUp = false;
  private last = '';
  private current: RunState;
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<RunState> | null = null;

  constructor(
    cfg: Pick<HarnessConfig, 'repo' | 'stateDir' | 'runCmd' | 'runUrl'>,
    bus: Pick<ConversationBus, 'publish'>,
    opts: { bench?: Workbench; settings?: Settings; pollMs?: number } = {}
  ) {
    this.cfg = cfg;
    this.bus = bus;
    this.bench = opts.bench;
    this.settings = opts.settings;
    this.pollMs = opts.pollMs ?? 3000;
    this.logFile = path.join(cfg.stateDir, 'run.log');
    this.detected = this.detect();
    // A placeholder until the first refresh reads the port — `start()` runs one at once.
    this.current = {
      command: this.detected?.command ?? null,
      why: this.detected?.why ?? null,
      url: null,
      urlWhy: null,
      phase: 'stopped',
      owned: false,
      note: null,
      exit: null,
      logAt: null,
    };
  }

  private detect() {
    const set = this.settings?.get('runCmd');
    return set ? detectRun(this.cfg.repo, set, 'set here') : detectRun(this.cfg.repo, this.cfg.runCmd);
  }

  /** Declared beats printed, and the page's setting beats the env — settings.ts. */
  private urlInForce(): { url: string; why: string } | null {
    const set = this.settings?.get('runUrl');
    for (const [raw, why] of [
      [set, 'set here'],
      [this.cfg.runUrl, 'HARNESS_RUN_URL'],
    ] as const) {
      if (!raw) continue;
      const v = vetBenchUrl(raw);
      if (v.ok && portOf(v.url)) return { url: v.url, why };
    }
    return this.learned ? { url: this.learned, why: 'printed by the app (this run only)' } : null;
  }

  start() {
    console.log(
      this.detected
        ? `  run:   ${this.detected.command.join(' ')} — from ${this.detected.why}${this.urlInForce() ? ` · ${this.urlInForce()!.url}` : ' · no url declared'}`
        : '  run:   nothing detected (set HARNESS_RUN_CMD to name one)'
    );
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.pollMs);
    this.timer.unref?.();
  }

  /**
   * The harness is going. The APP is not: it runs in a session of its own so a
   * /restart does not take it down, and the next harness finds it on the port.
   */
  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  state(): RunState {
    return { ...this.current };
  }

  /** A new command or url from the gear. The old run's exit is about a command that no longer runs here. */
  setCommand(value: string | null) {
    this.settings?.set('runCmd', value);
    this.detected = this.detect();
    this.exit = null;
    void this.refresh();
  }

  setUrl(value: string | null) {
    this.settings?.set('runUrl', value);
    this.wasUp = false;
    void this.refresh();
  }

  /** The tail of what a start made here printed. */
  log(maxBytes = 64 * 1024): { text: string; at: number } | null {
    try {
      const st = fs.statSync(this.logFile);
      const fd = fs.openSync(this.logFile, 'r');
      try {
        const len = Math.min(st.size, maxBytes);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        return { text: buf.toString('utf8'), at: st.birthtimeMs || st.ctimeMs };
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  /** Recompute from the world, publish on change. Never overlaps itself. */
  refresh(): Promise<RunState> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.compute().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async compute(): Promise<RunState> {
    const alive = this.child !== null;
    if (alive && !this.learned) this.learn();
    const where = this.urlInForce();
    let phase: RunPhase;
    let note: string | null = null;

    if (this.stopping) {
      phase = 'stopping';
    } else if (where) {
      const port = portOf(where.url)!;
      const up = await probe(port);
      if (up && !this.wasUp) this.holder = await attribute(this.cfg.repo, port);
      if (!up) this.holder = { kind: 'none' };
      this.wasUp = up;
      if (up && this.holder.kind === 'foreign') {
        phase = 'taken';
        note = this.holder.reason;
      } else if (up) {
        phase = 'running';
      } else if (alive) {
        phase = 'starting';
        if (Date.now() - this.child!.startedAt > SLOW_START_MS) {
          note = `running, but nothing answers on port ${port} yet — is ${where.why === 'set here' || where.why === 'HARNESS_RUN_URL' ? 'the declared url' : 'that url'} right?`;
        }
      } else {
        phase = this.exit ? 'crashed' : 'stopped';
      }
    } else {
      // No address at all: only a start made here can be seen, and the panel
      // says how to make the button see the rest.
      phase = alive ? 'running' : this.exit ? 'crashed' : 'stopped';
      if (alive) note = 'no url known — declare HARNESS_RUN_URL so the button can see it after a restart';
    }
    if (phase === 'crashed' && this.exit) {
      note = `exited ${this.exit.signal ? `on ${this.exit.signal}` : `with code ${this.exit.code}`}`;
    }

    const logAt = this.log(1)?.at ?? null;
    this.current = {
      command: this.detected?.command ?? null,
      why: this.detected?.why ?? null,
      url: where?.url ?? null,
      urlWhy: where?.why ?? null,
      phase,
      owned: alive,
      note,
      exit: phase === 'crashed' ? this.exit : null,
      logAt,
    };
    this.syncBench();
    const sig = JSON.stringify(this.current);
    if (sig !== this.last) {
      this.last = sig;
      this.bus.publish({ type: 'run', state: this.state() });
    }
    return this.state();
  }

  private syncBench() {
    if (!this.bench) return;
    const { phase, url } = this.current;
    let changed = false;
    if (phase === 'running' && url) changed = this.bench.offerRun(url);
    else if (phase === 'stopped' || phase === 'crashed' || phase === 'taken') changed = this.bench.clearRun();
    if (changed) this.bus.publish(this.bench.message());
  }

  /** Read the address off the log while the start is young. */
  private learn() {
    const url = sniffUrl(this.log(32 * 1024)?.text ?? '');
    if (url) this.learned = url;
  }

  async startApp(): Promise<{ ok: true; state: RunState } | { ok: false; reason: string }> {
    if (!this.detected) return { ok: false, reason: 'nothing to run — set HARNESS_RUN_CMD, or the run command in the gear' };
    if (this.stopping) return { ok: false, reason: 'still stopping' };
    if (this.child) return { ok: true, state: await this.refresh() };
    const where = this.urlInForce();
    if (where) {
      const port = portOf(where.url)!;
      if (await probe(port)) {
        // Already up — ours (started elsewhere) is a no-op; anyone else's means a
        // second copy would die on EADDRINUSE, so say who has it instead.
        const holder = await attribute(this.cfg.repo, port);
        if (holder.kind === 'foreign') return { ok: false, reason: holder.reason };
        return { ok: true, state: await this.refresh() };
      }
    }

    const [cmd, ...args] = this.detected.command;
    let fd: number;
    try {
      // Removed, not truncated: the file's BIRTH time is what the panel shows as
      // "output from the start at …", and truncating keeps the old one.
      fs.rmSync(this.logFile, { force: true });
      fd = fs.openSync(this.logFile, 'w');
    } catch (e) {
      return { ok: false, reason: `cannot write the log: ${String(e)}` };
    }
    let proc: ChildProcess;
    try {
      proc = spawn(cmd, args, {
        cwd: this.cfg.repo,
        // A session of its own: signalled as one group, and out of the terminal's,
        // so neither a Ctrl-C on the harness nor a /restart reaches it. ⚠️ NOT in
        // runCommand's exit backstop, which kills on the way out — the opposite
        // of what an app that outlives the harness needs.
        detached: true,
        stdio: ['ignore', fd, fd],
        // No colour in a log read as text. Not CI=1: that changes what a dev
        // server does, and this is the app as he would run it.
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
    } catch (e) {
      fs.closeSync(fd);
      return { ok: false, reason: `could not start ${cmd}: ${String(e)}` };
    }
    // The child has its own copy of the descriptor.
    fs.closeSync(fd);
    if (proc.pid === undefined) {
      return await new Promise((resolve) =>
        proc.once('error', (e) => resolve({ ok: false, reason: `could not start ${cmd}: ${String(e)}` }))
      );
    }
    proc.unref();
    const child = { proc, pgid: proc.pid, startedAt: Date.now() };
    this.child = child;
    this.learned = null;
    this.exit = null;
    this.wasUp = false;
    proc.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.learned = null;
      // Asked to stop is not a crash; anything else is the red light, log kept.
      if (!this.stopping) this.exit = { code, signal, at: Date.now() };
      // The leader is gone, so anything left in its group is an orphan of a run
      // nobody can see any more — a watcher whose child it was, a worker pool.
      signalGroup(child.pgid, 'SIGTERM');
      void this.refresh();
    });
    return { ok: true, state: await this.refresh() };
  }

  async stopApp(): Promise<{ ok: true; state: RunState } | { ok: false; reason: string }> {
    if (this.stopping) return { ok: true, state: this.state() };
    const groups = new Set<number>();
    if (this.child) groups.add(this.child.pgid);
    const where = this.urlInForce();
    const port = where ? portOf(where.url) : null;
    if (port && (await probe(port))) {
      // Proved AGAIN at the press, never from the cache: the listener may have
      // changed hands since the port came up.
      const holder = await attribute(this.cfg.repo, port);
      if (holder.kind === 'ours') groups.add(holder.pgid);
      else if (holder.kind === 'foreign' && !groups.size) return { ok: false, reason: holder.reason };
    }
    if (!groups.size) {
      this.exit = null;
      return { ok: true, state: await this.refresh() };
    }

    this.stopping = true;
    await this.refresh();
    try {
      for (const g of groups) signalGroup(g, 'SIGTERM');
      const deadline = Date.now() + GRACE_MS;
      const alive = async () => {
        for (const g of groups) if ((await membersOf(g)).length) return true;
        return false;
      };
      while ((await alive()) && Date.now() < deadline) await sleep(150);
      if (await alive()) {
        for (const g of groups) signalGroup(g, 'SIGKILL');
        await sleep(200);
      }
      // The socket can outlive the process by a moment; a ▶ pressed straight
      // after should not find the port still "up".
      if (port) for (let i = 0; i < 20 && (await probe(port)); i++) await sleep(100);
    } finally {
      this.stopping = false;
      this.exit = null;
      this.wasUp = false;
      this.holder = { kind: 'none' };
    }
    return { ok: true, state: await this.refresh() };
  }

  /** Stop, then start — the act after a fix, as one press. */
  async restartApp(): Promise<{ ok: true; state: RunState } | { ok: false; reason: string }> {
    const stopped = await this.stopApp();
    if (!stopped.ok) return stopped;
    return this.startApp();
  }
}
