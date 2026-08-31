// Build it — the other question you ask twenty times a day, and the one the
// page could only answer by asking her to run it for you.
//
// Detection is the test monitor's, applied to the other target: the harness
// never invents a command, it runs what the project already declares. What is
// deliberately NOT here is a schedule. The test monitor is gated behind an
// explicit per-repo enable because it executes project code because you saved a
// file; this only ever runs because someone pressed something, so the press is
// the authorisation and there is no gate to keep.
//
// ⚠️ Which is also the line to hold if this ever grows one: the moment anything
// here fires on its own, it needs that gate back.
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { HarnessConfig } from './config.ts';
import type { ConversationBus } from './bus.ts';
import { runCommand, treeFingerprint, type CommandResult } from './runCommand.ts';
import type { Settings } from './settings.ts';

/** A finished build. `cancelled` is a stop you asked for, not a failure. */
export type BuildRun = CommandResult & { cancelled?: boolean };

export type BuildState = {
  /** argv, not a shell string — nothing here is interpreted by a shell. */
  command: string[] | null;
  why: string | null;
  running: boolean;
  /** green | yellow | red | grey — the test light's vocabulary, same meanings. */
  light: 'green' | 'yellow' | 'red' | 'grey';
  /** The tree moved since that build, so the light is about stale news. */
  stale: boolean;
  last: BuildRun | null;
};

/**
 * What this project calls building, or nothing at all.
 *
 * Same shape and same order as `detectRunner`, and the same refusal at the end:
 * a repo the detectors do not recognise gets NOTHING. In particular there is no
 * fallback to `dev` or `start` — those do not terminate, and a fire-and-report
 * button pointed at a dev server is a light stuck on yellow until the timeout
 * kills the server out from under you.
 */
export function detectBuild(
  repo: string,
  override?: string,
  /** Where the override came from, for the panel — the page says which layer won. */
  overrideWhy = 'HARNESS_BUILD_CMD'
): { command: string[]; why: string } | null {
  if (override?.trim()) {
    // Split on whitespace rather than handing it to a shell, exactly as the test
    // command is. A command that needs shell syntax should be a project script.
    return { command: override.trim().split(/\s+/), why: overrideWhy };
  }
  const has = (f: string) => fs.existsSync(path.join(repo, f));
  const read = (f: string) => {
    try {
      return fs.readFileSync(path.join(repo, f), 'utf8');
    } catch {
      return '';
    }
  };

  if (has('package.json')) {
    try {
      const pkg = JSON.parse(read('package.json'));
      if (pkg?.scripts?.build) {
        const declared = /^(pnpm|yarn|npm)/.exec(String(pkg.packageManager ?? ''))?.[1];
        const pm = declared ?? (has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm');
        // `run` explicitly: `pnpm build` happens to work and `npm build` is not a
        // command at all, so the form that is right everywhere is the one to use.
        return { command: [pm, 'run', 'build'], why: `package.json scripts.build (${pm})` };
      }
    } catch {
      /* an unparseable package.json declares nothing */
    }
  }

  const entries = (() => {
    try {
      return fs.readdirSync(repo);
    } catch {
      return [];
    }
  })();
  if (entries.some((f) => f.endsWith('.sln') || f.endsWith('.csproj'))) {
    return { command: ['dotnet', 'build'], why: 'a .sln/.csproj in the root' };
  }
  if (has('Cargo.toml')) return { command: ['cargo', 'build'], why: 'Cargo.toml' };
  if (has('go.mod')) return { command: ['go', 'build', './...'], why: 'go.mod' };
  if (has('Makefile') && /^build:/m.test(read('Makefile'))) {
    return { command: ['make', 'build'], why: 'a build: target in the Makefile' };
  }
  return null;
}

export class BuildRunner {
  private cfg: HarnessConfig;
  private bus: ConversationBus;
  private detected: { command: string[]; why: string } | null;
  private fingerprint: () => string;
  private stalePollMs: number;
  private settings?: Settings;
  private running = false;
  private cancelling = false;
  private child: ChildProcess | null = null;
  private last: BuildRun | null = null;
  /** The tree as it was when the last build STARTED, and whether it has moved. */
  private ranFingerprint = '';
  private stale = false;
  private watch: NodeJS.Timeout | null = null;

  constructor(
    cfg: HarnessConfig,
    bus: ConversationBus,
    opts: { fingerprint?: () => string; stalePollMs?: number; settings?: Settings } = {}
  ) {
    this.cfg = cfg;
    this.bus = bus;
    this.settings = opts.settings;
    this.detected = this.detect();
    this.fingerprint = opts.fingerprint ?? (() => treeFingerprint(cfg.repo));
    this.stalePollMs = opts.stalePollMs ?? 5000;
  }

  /**
   * What to run, and where that came from.
   *
   * The page's own setting wins over the env layers and over detection — see
   * settings.ts for why that way round rather than the other. `why` travels with
   * it, because the only thing that makes a precedence rule liveable is the panel
   * saying which layer actually won.
   */
  private detect() {
    const set = this.settings?.get('buildCmd');
    return set ? detectBuild(this.cfg.repo, set, 'set here') : detectBuild(this.cfg.repo, this.cfg.buildCmd);
  }

  /**
   * A new command, from the page. Empty hands it back to the env layer, or to
   * detection.
   *
   * ⚠️ The last result goes with it. A green light earned by the command you just
   * replaced is a claim about something that no longer runs here, and it would
   * look exactly like the new command having passed.
   */
  setCommand(value: string | null) {
    this.settings?.set('buildCmd', value);
    this.detected = this.detect();
    this.last = null;
    this.ranFingerprint = '';
    this.stale = false;
    this.stopWatch();
    this.publish();
  }

  start() {
    if (this.detected) {
      console.log(`  build: ${this.detected.command.join(' ')} — from ${this.detected.why}`);
    } else {
      console.log('  build: nothing detected (set HARNESS_BUILD_CMD to name one)');
    }
    this.publish();
  }

  stop() {
    this.stopWatch();
    this.child?.kill('SIGKILL');
  }

  /** A build you no longer want. Not a failure — see `light`. */
  cancel() {
    if (!this.running) return;
    this.cancelling = true;
    this.child?.kill('SIGTERM');
  }

  state(): BuildState {
    return {
      command: this.detected?.command ?? null,
      why: this.detected?.why ?? null,
      running: this.running,
      light: this.light(),
      stale: this.stale,
      last: this.last,
    };
  }

  private light(): BuildState['light'] {
    if (!this.detected) return 'grey';
    if (this.running) return 'yellow';
    // A build you stopped is no news at all — reporting it red would make the
    // strip claim something is broken because you changed your mind.
    if (!this.last || this.last.cancelled) return 'grey';
    if (this.last.timedOut || (this.last.exitCode ?? 1) !== 0) return 'red';
    // Built, against a tree that has moved on. Green would be a claim we cannot
    // make; yellow says "it built, and that was before your last edit".
    return this.stale ? 'yellow' : 'green';
  }

  private publish() {
    this.bus.publish({ type: 'build', state: this.state() });
  }

  async run(): Promise<void> {
    if (this.running || !this.detected) return;
    this.running = true;
    this.cancelling = false;
    this.stopWatch();
    const startedFingerprint = this.fingerprint();
    this.publish();

    const result = await runCommand({
      command: this.detected.command,
      cwd: this.cfg.repo,
      timeoutMs: this.cfg.buildTimeoutMs,
      onStart: (child) => (this.child = child),
    });

    this.child = null;
    this.running = false;
    this.last = this.cancelling ? { ...result, cancelled: true } : result;
    this.ranFingerprint = startedFingerprint;
    this.stale = false;
    this.publish();
    this.startWatch();
  }

  /**
   * A finished build goes stale the moment the tree moves, and nothing else here
   * would ever say so — the test monitor next door polls for its own reasons and
   * this has none of them.
   *
   * So the poll exists only while there is something left to invalidate: it
   * starts when a build finishes and stops the instant it fires, because a stale
   * light cannot get staler. An empty fingerprint is NO OPINION rather than a
   * value (see runCommand.ts), so a repo git cannot read is never watched — two
   * empty fingerprints compare equal, and the poll would run forever saying
   * nothing.
   */
  private startWatch() {
    if (!this.ranFingerprint || this.watch) return;
    this.watch = setInterval(() => {
      const now = this.fingerprint();
      if (!now || now === this.ranFingerprint) return;
      this.stale = true;
      this.stopWatch();
      this.publish();
    }, this.stalePollMs);
    this.watch.unref?.();
  }

  private stopWatch() {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
  }
}
