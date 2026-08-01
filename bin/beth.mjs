#!/usr/bin/env node
// `beth` — start the director harness against whatever repo you are standing in.
//
//   cd ~/Sources/beadgame && beth
//
// One command, everything up: binds to the git root you are in, picks a free port
// so several repos can run side by side, brings the ngrok tunnel along (voice does
// not work without it, because ElevenLabs dials IN to us), and tears both down
// together on Ctrl-C.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (flag('help')) {
  console.log(`beth — director harness

  beth                 bind to the git root of the current directory
  beth --repo <path>   bind to a specific repo
  beth --port <n>      force a port (default: first free from 4620)
                       the UI/API stay on localhost; only the voice websocket
                       port (port+1) is tunnelled
  beth --model <id>    claude-opus-5 (default) | claude-fable-5
  beth --fresh         ignore any previous session
  beth --no-tunnel     do not start ngrok (voice will be text-only)
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
 * Two beths at once cost Danny a debugging session, and the symptoms named
 * nothing: his typed and spoken text appeared in neither chat, Beth answered him
 * out loud anyway, and a plan he clicked never reached her.
 *
 * The cause is that VOICE IS A SINGLETON. There is one Speech Engine, holding
 * one wsUrl, and one tunnel hostname that can forward to exactly one voice port.
 * So ElevenLabs talks to whichever instance owns the tunnel, while the page in
 * front of you may belong to the other — and that page stays perfectly healthy
 * looking, because nothing is broken from its point of view. It simply is not
 * the harness in the conversation.
 *
 * A second instance on the SAME repo has no legitimate use, so refuse it. A
 * second one on a different repo is reasonable — but it must be said out loud
 * that only one of them will have voice.
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

// --- a free port, so a second repo does not collide with the first ---
const portFree = (p) =>
  new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(p, '127.0.0.1');
  });

const running = liveInstances();
const sameRepo = running.find((r) => r.repo === repo);
if (sameRepo) {
  console.error(`Already running for ${path.basename(repo)} — pid ${sameRepo.pid}, http://localhost:${sameRepo.port}`);
  console.error('Two instances on one repo fight over the Speech Engine: you end up talking to one');
  console.error('and watching the other, which looks exactly like the UI being broken.');
  console.error(`Open http://localhost:${sameRepo.port}, or stop that one first.`);
  process.exit(1);
}

const wanted = Number(value('port', process.env.HARNESS_PORT ?? 4620));
let port = wanted;
if (!flag('port')) for (let i = 0; i < 20 && !(await portFree(port)); i++) port = wanted + i + 1;
if (!(await portFree(port))) {
  console.error(`Port ${port} is busy. Pass --port <n>.`);
  process.exit(1);
}

// The PUBLIC port. The UI and API stay on loopback; only this one is tunnelled,
// and it carries nothing but the ElevenLabs websocket upgrade. Keeping them
// separate is what stops the tunnel from publishing /api/turn to the internet.
let voicePort = Number(process.env.HARNESS_VOICE_PORT ?? port + 1);
for (let i = 0; i < 20 && !(await portFree(voicePort)); i++) voicePort = port + 1 + i + 1;

// --- config: real env, then the bound repo's .env, then machine-wide ---
// Same three layers as src/config.ts. The machine file is where the ElevenLabs
// credentials belong — one account and one tunnel hostname for this Mac — so
// binding to a new repo does not silently start a text-only harness.
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
const wsUrl = conf('HARNESS_PUBLIC_WS_URL');
const voiceConfigured = Boolean(conf('ELEVENLABS_API_KEY') && conf('SPEECH_ENGINE_ID'));

const env = { ...process.env, HARNESS_REPO: repo, HARNESS_PORT: String(port), HARNESS_VOICE_PORT: String(voicePort) };
if (value('model', null)) env.HARNESS_MODEL = value('model', null);
if (flag('fresh')) delete env.HARNESS_RESUME;

// --- claim this instance, so the next `beth` can see us ---
fs.mkdirSync(INSTANCE_DIR, { recursive: true });
const instanceFile = path.join(INSTANCE_DIR, `${process.pid}.json`);
fs.writeFileSync(instanceFile, JSON.stringify({ pid: process.pid, repo, port, voicePort, at: new Date().toISOString() }));

// A second instance on ANOTHER repo is legitimate, but only one of them can have
// voice — so say which, rather than letting it be discovered by talking into a
// harness that is not listening.
if (running.length && voiceConfigured && wsUrl && !flag('no-tunnel')) {
  const other = running.map((r) => `${path.basename(r.repo)} (:${r.port})`).join(', ');
  console.log(`· ⚠ already running: ${other}`);
  console.log('    voice is a SINGLE Speech Engine — whichever instance owns the tunnel gets it,');
  console.log('    and the other is text-only. Talking to the wrong window looks like a dead UI.');
}

// --- start the harness ---
console.log(`· ${path.basename(repo)} → http://localhost:${port}`);
const harness = spawn(process.execPath, [path.join(HARNESS, 'src', 'main.ts')], { env, stdio: 'inherit' });

const reachable = async (url) => {
  try {
    const res = await fetch(url, {
      headers: { 'ngrok-skip-browser-warning': '1' },
      signal: AbortSignal.timeout(5000),
    });
    return (await res.text()).trimStart().startsWith('{');
  } catch {
    return false;
  }
};
const waitFor = async (url, seconds) => {
  for (let i = 0; i < seconds; i++) {
    if (await reachable(url)) return true;
    await sleep(1000);
  }
  return false;
};

// --- bring the tunnel along ---
// ElevenLabs is the websocket CLIENT here, so without a public URL pointing at
// this process voice connects and is simply never heard. That failure is silent,
// which is exactly why this is automated rather than left as a second terminal.
let tunnel = null;
if (!voiceConfigured) {
  console.log('· voice off — no ELEVENLABS_API_KEY / SPEECH_ENGINE_ID (text still works)');
  console.log(`    put them in ~/.director-harness/.env to cover every repo at once`);
} else if (!wsUrl) {
  console.log('· voice off — HARNESS_PUBLIC_WS_URL not set (ElevenLabs dials IN, so it needs a public URL)');
} else if (flag('no-tunnel')) {
  console.log('· tunnel skipped (--no-tunnel)');
} else {
  const origin = wsUrl.replace(/^wss:/, 'https:').replace(/\/[^/]*$/, '');
  const host = new URL(origin).host;

  await waitFor(`http://localhost:${port}/api/state`, 30);

  if (await reachable(`${origin}/healthz`)) {
    console.log(`· tunnel already up → ${origin}`);
  } else {
    try {
      execFileSync('which', ['ngrok'], { stdio: 'ignore' });
    } catch {
      console.log(`· ⚠ ngrok not installed — voice needs ${origin} to reach this process (brew install ngrok)`);
    }
    tunnel = spawn('ngrok', ['http', String(voicePort), '--url', host, '--log', 'stdout'], { stdio: 'ignore' });
    tunnel.on('error', () => console.log('· ⚠ could not start ngrok'));
    if (await waitFor(`${origin}/healthz`, 20)) {
      console.log(`· tunnel up → ${origin}`);
    } else {
      console.log(`· ⚠ tunnel did not come up. If ngrok says the endpoint is already online,`);
      console.log('    delete the Cloud Endpoint in the ngrok dashboard — it occupies the hostname.');
    }
  }
}

if (!flag('no-open') && process.platform === 'darwin') {
  spawn('open', [`http://localhost:${port}`], { stdio: 'ignore' }).unref();
}

// --- one Ctrl-C takes down both ---
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
  tunnel?.kill('SIGTERM');
  harness.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
harness.on('exit', (code) => {
  releaseInstance();
  tunnel?.kill('SIGTERM');
  process.exit(code ?? 0);
});
