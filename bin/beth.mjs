#!/usr/bin/env node
// `beth` — start the director harness against whatever repo you are standing in.
//
//   cd ~/Sources/beadgame && beth
//
// One command, everything up: binds to the git root you are in, picks a free port
// so several repos can run side by side, and opens a browser.
//
// It used to bring an ngrok tunnel along, because ElevenLabs dialled IN and voice
// did not work without a public URL. Nothing dials in now — she is heard by the
// browser and speaks over loopback — so there is no tunnel, no public port, and
// no reason a second repo cannot have voice at the same time as the first.
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

if (flag('help')) {
  console.log(`beth — director harness

  beth                 bind to the git root of the current directory
  beth --repo <path>   bind to a specific repo
  beth --port <n>      force a port (default: first free from 4620)
                       everything binds to localhost — there is no public port
  beth --model <id>    claude-opus-5 (default) | claude-fable-5
  beth --fresh         ignore any previous session
  beth --no-open       do not open a browser
`);
  process.exit(0);
}

// --- which repo? ---
let repo = value('repo', process.env.HARNESS_REPO);
if (!repo) {
  try {
    repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    console.error('Not inside a git repository. Run from a repo, or pass --repo <path>.');
    process.exit(1);
  }
}
repo = path.resolve(repo);
if (!fs.existsSync(path.join(repo, '.claude'))) {
  console.error(`${repo} has no .claude directory — the harness expects a repo Claude Code works in.`);
  process.exit(1);
}

/**
 * --- who else is already running ---
 *
 * Voice used to be a SINGLETON — one Speech Engine, one stored wsUrl, one tunnel
 * hostname forwarding to exactly one voice port — so two beths meant ElevenLabs
 * talked to whichever owned the tunnel while you watched the other, which looked
 * exactly like a broken UI. That is gone: every instance now has its own ear and
 * its own mouth, both on loopback, and any number can have voice at once.
 *
 * The check stays for the part that was never about voice: two directors on ONE
 * repo would edit the same tree from two conversations. Port bookkeeping stays
 * too, so a second repo does not land on the first one's port.
 */
const INSTANCE_DIR = path.join(process.env.HOME ?? '', '.director-harness', 'instances');

const liveInstances = () => {
  if (!fs.existsSync(INSTANCE_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(INSTANCE_DIR)) {
    const file = path.join(INSTANCE_DIR, f);
    try {
      const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Signal 0 tests for existence without touching the process.
      process.kill(rec.pid, 0);
      out.push(rec);
    } catch {
      // Dead or unreadable — clear it out rather than let it haunt the check.
      try {
        fs.unlinkSync(file);
      } catch {}
    }
  }
  return out;
};

const running = liveInstances();
const sameRepo = running.find((r) => r.repo === repo);
if (sameRepo) {
  console.error(`Already running for ${path.basename(repo)} — pid ${sameRepo.pid}, http://localhost:${sameRepo.port}`);
  console.error('Two directors on one repo means two conversations editing the same tree.');
  console.error(`Open http://localhost:${sameRepo.port}, or stop that one first.`);
  process.exit(1);
}

// --- a free port, so a second repo does not collide with the first ---
//
// ⚠️ Probing 127.0.0.1 alone is NOT enough. A server that binds with `listen(port)`
// and no host takes the IPv6 wildcard, so a probe on IPv4 loopback finds a port
// "free" while something is already sitting on it — which is how a tulito instance
// took 4621 while beadgame's voice port was there, the two coexisting as `*:4621`
// and `127.0.0.1:4621`. So a port is free only if it binds on BOTH, and only if no
// live instance has claimed it.
const bindable = (p, host) =>
  new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    if (host) s.listen(p, host);
    else s.listen(p);
  });

const claimed = new Set(running.map((r) => r.port).filter(Boolean));
const portFree = async (p) => !claimed.has(p) && (await bindable(p)) && (await bindable(p, '127.0.0.1'));

const wanted = Number(value('port', process.env.HARNESS_PORT ?? 4620));
let port = wanted;
if (!flag('port')) for (let i = 0; i < 20 && !(await portFree(port)); i++) port = wanted + i + 1;
if (!(await portFree(port))) {
  console.error(`Port ${port} is busy. Pass --port <n>.`);
  process.exit(1);
}

// --- config: real env, then the bound repo's .env, then machine-wide ---
// Same three layers as src/config.ts. The machine file is where the ElevenLabs
// credentials belong — one account for this Mac — so binding to a new repo does
// not silently start a text-only harness.
const readEnv = (f) => {
  const out = {};
  if (!fs.existsSync(f)) return out;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
};
const repoEnv = readEnv(path.join(repo, '.env'));
const machineEnv = readEnv(path.join(process.env.HOME ?? '', '.director-harness', '.env'));
const conf = (k) => process.env[k] ?? repoEnv[k] ?? machineEnv[k];
const voiceConfigured = Boolean(conf('ELEVENLABS_API_KEY') && (conf('HARNESS_VOICE_ID') || conf('SPEECH_ENGINE_ID')));

const env = { ...process.env, HARNESS_REPO: repo, HARNESS_PORT: String(port) };
if (value('model', null)) env.HARNESS_MODEL = value('model', null);
if (flag('fresh')) delete env.HARNESS_RESUME;

// --- claim this instance, so the next `beth` can see us ---
fs.mkdirSync(INSTANCE_DIR, { recursive: true });
const instanceFile = path.join(INSTANCE_DIR, `${process.pid}.json`);
fs.writeFileSync(instanceFile, JSON.stringify({ pid: process.pid, repo, port, at: new Date().toISOString() }));

// Worth saying, but no longer a warning: they all have voice now.
if (running.length) {
  console.log(`· also running: ${running.map((r) => `${path.basename(r.repo)} (:${r.port})`).join(', ')}`);
}
if (!voiceConfigured) {
  console.log('· voice off — no ELEVENLABS_API_KEY (text still works)');
  console.log('    put it in ~/.director-harness/.env to cover every repo at once');
}

// --- start the harness ---
console.log(`· ${path.basename(repo)} → http://localhost:${port}`);
const harness = spawn(process.execPath, [path.join(HARNESS, 'src', 'main.ts')], { env, stdio: 'inherit' });

if (!flag('no-open') && process.platform === 'darwin') {
  spawn('open', [`http://localhost:${port}`], { stdio: 'ignore' }).unref();
}

// --- Ctrl-C stops the harness ---
let stopping = false;
const releaseInstance = () => {
  try {
    fs.unlinkSync(instanceFile);
  } catch {}
};
const stop = () => {
  if (stopping) return;
  stopping = true;
  releaseInstance();
  harness.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
harness.on('exit', (code) => {
  releaseInstance();
  process.exit(code ?? 0);
});
