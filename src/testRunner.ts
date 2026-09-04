// Is the tree green? — the question you ask twenty times a day and the page
// could not answer.
//
// Project-agnostic the same way work readers are: the harness DETECTS, the
// project DECIDES. It never invents a command; it runs what the project already
// declares, because a guessed command is a shell execution nobody authorised.
//
// ⚠️ This executes project code on a schedule without anyone asking, which is a
// real hazard — a suite that touches the network, spins a container, or costs
// money must not start because you happened to save a file. So it is OFF until
// enabled once per repo, and the detected command is shown before you enable it.
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { HarnessConfig } from './config.ts';
import type { ConversationBus, UIMessage } from './bus.ts';
import { MAX_OUTPUT, runCommand, treeFingerprint, type CommandResult } from './runCommand.ts';
import type { Settings } from './settings.ts';

export type TestFailure = {
  /** What Beth should call it — the test's own name, said aloud. */
  spoken: string;
  /** Repo-relative when we could work it out. */
  path?: string;
  line?: number;
  /** The assertion text, for the turn she gets when you click it. */
  detail?: string;
};

export type TestRun = CommandResult & { failures: TestFailure[] };

export type TestState = {
  enabled: boolean;
  /** argv, not a shell string — nothing here is interpreted by a shell. */
  command: string[] | null;
  why: string | null;
  running: boolean;
  /** green | yellow | red | grey */
  light: 'green' | 'yellow' | 'red' | 'grey';
  /** The tree changed since the last run, so the light is about stale news. */
  stale: boolean;
  last: TestRun | null;
};

// --- detection ---------------------------------------------------------------

/**
 * First hit wins, and the order is deliberate: a repo with both a package.json
 * and a Makefile means the package.json.
 */
export function detectRunner(
  repo: string,
  override?: string,
  /** Where the override came from, for the panel — the page says which layer won. */
  overrideWhy = 'HARNESS_TEST_CMD'
): { command: string[]; why: string } | null {
  if (override?.trim()) {
    // Split on whitespace rather than handing it to a shell. A command that
    // genuinely needs shell syntax should be a script the project already has.
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
      if (pkg?.scripts?.test) {
        // Believe the project's own declaration first: `packageManager` is what
        // corepack reads, so it is the least ambiguous signal available.
        const declared = /^(pnpm|yarn|npm)/.exec(String(pkg.packageManager ?? ''))?.[1];
        const pm = declared ?? (has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm');
        return { command: [pm, 'test'], why: `package.json scripts.test (${pm})` };
      }
    } catch {
      /* an unparseable package.json is not a runner */
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
    return { command: ['dotnet', 'test'], why: 'a .sln/.csproj in the root' };
  }
  if (has('Cargo.toml')) return { command: ['cargo', 'test'], why: 'Cargo.toml' };
  if (has('go.mod')) return { command: ['go', 'test', './...'], why: 'go.mod' };
  if (has('pyproject.toml') || has('pytest.ini')) {
    return { command: ['pytest'], why: has('pytest.ini') ? 'pytest.ini' : 'pyproject.toml' };
  }
  if (has('Makefile') && /^test:/m.test(read('Makefile'))) {
    return { command: ['make', 'test'], why: 'a test: target in the Makefile' };
  }
  return null;
}

// --- parsing -----------------------------------------------------------------

/**
 * An absolute path inside the repo is noise; say it the way he thinks of it.
 *
 * Through realpath, because a repo reached via a symlink (/tmp → /private/tmp on
 * macOS, and every worktree) reports one root and prints the other — and then
 * every location stays absolute and unreadable.
 */
const realRepo = (repo: string) => {
  try {
    return fs.realpathSync(repo);
  } catch {
    return repo;
  }
};

const rel = (repo: string, p: string) => {
  const clean = p.replace(/^file:\/\//, '');
  for (const root of new Set([repo, realRepo(repo)])) {
    if (clean.startsWith(root + path.sep)) return clean.slice(root.length + 1);
  }
  return clean;
};

/** The first source location in a block of failure output, if there is one. */
function firstLocation(block: string, repo: string): { path?: string; line?: number } {
  const m =
    /(?:location:\s*'?|\(|\s|^)((?:file:\/\/)?[\w./~@+-]*\.[a-zA-Z]{1,5}):(\d+)(?::\d+)?/m.exec(block);
  if (!m) return {};
  return { path: rel(repo, m[1]), line: Number(m[2]) };
}

/**
 * Every parser runs and the richest result wins.
 *
 * Guessing the format from the command is the obvious approach and the wrong
 * one: a project's `test` script is frequently a wrapper that runs something
 * else entirely, and then the guess is confidently wrong. Trying them all costs
 * a few regexes over text we already have.
 */
export function parseFailures(output: string, repo: string): TestFailure[] {
  const results = [nodeSpec, nodeTap, pytest, goTest, cargoTest, dotnetTest].map((p) => p(output, repo));
  return dedupe(results.reduce((best, r) => (r.length > best.length ? r : best), [] as TestFailure[]));
}

/**
 * One entry per test, keeping the RICHEST.
 *
 * `node --test` names every failure twice: once in the run, and again in a
 * "failing tests:" section at the end that carries the actual error. Reporting
 * both gives you the same failure listed two or three times, one of them with no
 * detail — which reads as a broken parser, because it was.
 */
function dedupe(all: TestFailure[]): TestFailure[] {
  const by = new Map<string, TestFailure>();
  const richness = (f: TestFailure) => (f.detail ? 2 : 0) + (f.line ? 1 : 0);
  for (const f of all) {
    const prev = by.get(f.spoken);
    if (!prev || richness(f) > richness(prev)) by.set(f.spoken, f);
  }
  return [...by.values()];
}

/** `node --test` spec reporter: ✖ name, then an indented error block. */
function nodeSpec(output: string, repo: string): TestFailure[] {
  const out: TestFailure[] = [];
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*[✖✗]\s+(.+?)(?:\s+\(\d[\d.]*ms\))?\s*$/.exec(lines[i]);
    if (!m) continue;
    // Neither the rollup counts nor the "failing tests:" section header is a test.
    if (/^(tests|suites|fail|pass)\b/.test(m[1]) || /^(failing|passing) tests:?$/.test(m[1])) continue;
    // Stop at the next marker: node lists results first and repeats each failure
    // with its error afterwards, so an unbounded window steals the next one's.
    let end = i + 1;
    while (end < lines.length && end < i + 20 && !/^\s*[✔✖✗]\s/.test(lines[end])) end++;
    const block = lines.slice(i + 1, end).join('\n');
    out.push({ spoken: m[1].trim(), ...firstLocation(block, repo), detail: detailOf(block) });
  }
  return out;
}

/** TAP, which is what `node --test` emits when it is not writing to a terminal. */
function nodeTap(output: string, repo: string): TestFailure[] {
  const out: TestFailure[] = [];
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*not ok \d+\s*-?\s*(.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    const block = lines.slice(i + 1, i + 20).join('\n');
    out.push({ spoken: m[1].trim(), ...firstLocation(block, repo), detail: detailOf(block) });
  }
  return out;
}

/** pytest's summary line carries the file, the test and the reason in one. */
function pytest(output: string, repo: string): TestFailure[] {
  const out: TestFailure[] = [];
  for (const m of output.matchAll(/^FAILED\s+(\S+?)::(\S+?)(?:\s+-\s+(.*))?$/gm)) {
    out.push({ spoken: m[2].replace(/_/g, ' '), path: rel(repo, m[1]), detail: m[3]?.trim() });
  }
  return out;
}

/** go test: `--- FAIL: TestName` then `    file_test.go:42: message`. */
function goTest(output: string, repo: string): TestFailure[] {
  const out: TestFailure[] = [];
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*--- FAIL:\s+(\S+)/.exec(lines[i]);
    if (!m) continue;
    const block = lines.slice(i + 1, i + 10).join('\n');
    out.push({ spoken: m[1], ...firstLocation(block, repo), detail: detailOf(block) });
  }
  return out;
}

/** cargo: the panic carries the location; the `---- name stdout ----` the name. */
function cargoTest(output: string, repo: string): TestFailure[] {
  const out: TestFailure[] = [];
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*----\s+(\S+)\s+stdout\s+----/.exec(lines[i]);
    if (!m) continue;
    const block = lines.slice(i + 1, i + 10).join('\n');
    out.push({ spoken: m[1].split('::').pop()!.replace(/_/g, ' '), ...firstLocation(block, repo), detail: detailOf(block) });
  }
  return out;
}

/** dotnet test: `  Failed Name [12 ms]`, with `in /path/File.cs:line 42` below. */
function dotnetTest(output: string, repo: string): TestFailure[] {
  const out: TestFailure[] = [];
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:X|Failed)\s+(\S.*?)(?:\s+\[[\d.]+\s*m?s\])?\s*$/.exec(lines[i]);
    if (!m || /^(Failed!|Failed:)/.test(m[1])) continue;
    const block = lines.slice(i + 1, i + 12).join('\n');
    const loc = /in\s+(\S+):line\s+(\d+)/.exec(block);
    out.push({
      spoken: m[1].split('.').pop()!.trim(),
      ...(loc ? { path: rel(repo, loc[1]), line: Number(loc[2]) } : {}),
      detail: detailOf(block),
    });
  }
  return out;
}

/** The first line of a failure block that says something, capped. */
function detailOf(block: string): string | undefined {
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line || line === '---') continue;
    if (/^(at |duration_ms|location:|failureType|code:|test at |[✔✖✗ℹ]|\.\.\.)/.test(line)) continue;
    return line.slice(0, 300);
  }
  return undefined;
}

// --- the monitor -------------------------------------------------------------

export class TestMonitor {
  private cfg: HarnessConfig;
  private bus: ConversationBus;
  private stateFile: string;
  private detected: { command: string[]; why: string } | null;
  private enabled = false;
  private running = false;
  private child: ChildProcess | null = null;
  private last: TestRun | null = null;
  /** Fingerprint of the tree at the last run, so "unchanged" is a real answer. */
  private ranAt = 0;
  private ranFingerprint = '';
  private fingerprint = '';
  private changedAt = 0;
  private directorBusy = false;
  private timer: NodeJS.Timeout | null = null;
  private settings?: Settings;

  constructor(cfg: HarnessConfig, bus: ConversationBus, settings?: Settings) {
    this.cfg = cfg;
    this.bus = bus;
    this.settings = settings;
    this.stateFile = path.join(cfg.stateDir, 'tests.json');
    this.detected = this.detect();
    try {
      this.enabled = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))?.enabled === true;
    } catch {
      /* never enabled here — which is the safe default anyway */
    }
    // She runs her own suite during a turn. Two on one tree produce failures that
    // belong to neither, so hers wins and ours waits.
    bus.subscribe((m: UIMessage) => {
      if (m.type === 'status') this.directorBusy = m.state === 'thinking';
    });
  }

  /** What to run and where it came from — the page's setting wins. See settings.ts. */
  private detect() {
    const set = this.settings?.get('testCmd');
    return set ? detectRunner(this.cfg.repo, set, 'set here') : detectRunner(this.cfg.repo, this.cfg.testCmd);
  }

  /**
   * A new command, from the page. Empty hands it back to the env layer, or to
   * detection.
   *
   * ⚠️ The last run goes with it, failures and all: those name tests that the
   * command you just replaced was running, and clicking one would point her at a
   * failure nothing here can reproduce.
   */
  setCommand(value: string | null) {
    this.settings?.set('testCmd', value);
    this.detected = this.detect();
    this.last = null;
    this.ranFingerprint = '';
    this.publish();
  }

  start() {
    this.fingerprint = treeFingerprint(this.cfg.repo);
    this.changedAt = Date.now();
    // Polling rather than watching: `git status` already knows what changed, and
    // a recursive watch over a whole repo fires on every build artefact.
    this.timer = setInterval(() => this.tick(), 4000);
    this.timer.unref?.();
    if (this.detected) {
      console.log(
        `  tests: ${this.detected.command.join(' ')} — from ${this.detected.why}${this.enabled ? '' : ' (not enabled here)'}`
      );
    } else {
      console.log('  tests: no runner detected (set HARNESS_TEST_CMD to name one)');
    }
    this.publish();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.child?.kill('SIGKILL');
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({ enabled: on }));
    } catch {
      /* a state dir we cannot write is not worth failing a toggle over */
    }
    if (!on) this.child?.kill('SIGTERM');
    this.publish();
  }

  state(): TestState {
    return {
      enabled: this.enabled,
      command: this.detected?.command ?? null,
      why: this.detected?.why ?? null,
      running: this.running,
      light: this.light(),
      stale: Boolean(this.last) && this.fingerprint !== this.ranFingerprint,
      last: this.last,
    };
  }

  private light(): TestState['light'] {
    if (!this.enabled || !this.detected) return 'grey';
    if (this.running) return 'yellow';
    if (!this.last) return 'grey';
    if (this.last.timedOut || (this.last.exitCode ?? 1) !== 0) return 'red';
    // Passed, but against a tree that has moved on. Green would be a claim we
    // cannot make; yellow says "it passed, and that was before your last edit".
    return this.fingerprint === this.ranFingerprint ? 'green' : 'yellow';
  }

  private publish() {
    this.bus.publish({ type: 'tests', state: this.state() });
  }

  /** Changed, settled, and idle — all three, or nothing happens. */
  private tick() {
    if (!this.enabled || !this.detected || this.running) return;
    const fp = treeFingerprint(this.cfg.repo);
    if (!fp) return;
    if (fp !== this.fingerprint) {
      this.fingerprint = fp;
      this.changedAt = Date.now();
      this.publish(); // the light goes stale the moment the tree moves
      return;
    }
    if (fp === this.ranFingerprint) return; // nothing new since the last run
    if (Date.now() - this.changedAt < this.cfg.testSettleMs) return; // still typing
    if (Date.now() - this.ranAt < this.cfg.testMinIntervalMs) return; // too soon
    if (this.directorBusy) return; // her suite wins
    void this.run();
  }

  /** Run now, whatever the schedule thinks. The button, and the tick. */
  async run(): Promise<void> {
    if (this.running || !this.detected) return;
    this.running = true;
    // The previous run goes the moment a new one starts, failures and all: a
    // failure row still showing under "Running…" is one nothing has confirmed
    // yet, and pasting it to her would hand over last time's reasons as this
    // run's. Same rule as `setCommand`, and done on the server so every tab
    // clears at once.
    this.last = null;
    const startedFingerprint = this.fingerprint || treeFingerprint(this.cfg.repo);
    this.publish();

    const result = await runCommand({
      command: this.detected.command,
      cwd: this.cfg.repo,
      timeoutMs: this.cfg.testTimeoutMs,
      maxOutput: MAX_OUTPUT,
      onStart: (child) => (this.child = child),
    });

    this.child = null;
    this.running = false;
    this.ranAt = result.at;
    this.ranFingerprint = startedFingerprint;
    this.last = {
      ...result,
      // Only bother when something failed — a green run's output has no failures
      // to find and the parsers would be reading it for nothing.
      failures: result.exitCode === 0 && !result.timedOut ? [] : parseFailures(result.output, this.cfg.repo),
    };
    this.publish();
  }
}
