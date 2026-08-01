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

// --- a free port, so a second repo does not collide with the first ---
const portFree = (p) =>
  new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(p, '127.0.0.1');
  });

const wanted = Number(value('port', process.env.HARNESS_PORT ?? 4620));
let port = wanted;
if (!flag('port')) for (let i = 0; i < 20 && !(await portFree(port)); i++) port = wanted + i + 1;
if (!(await portFree(port))) {
  console.error(`Port ${port} is busy. Pass --port <n>.`);
  process.exit(1);
}

// --- config from the bound repo's .env ---
const repoEnv = (() => {
  const out = {};
  const f = path.join(repo, '.env');
  if (!fs.existsSync(f)) return out;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
})();
const conf = (k) => process.env[k] ?? repoEnv[k];
const wsUrl = conf('HARNESS_PUBLIC_WS_URL');
const voiceConfigured = Boolean(conf('ELEVENLABS_API_KEY') && conf('SPEECH_ENGINE_ID'));

const env = { ...process.env, HARNESS_REPO: repo, HARNESS_PORT: String(port) };
if (value('model', null)) env.HARNESS_MODEL = value('model', null);
if (flag('fresh')) delete env.HARNESS_RESUME;

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
  console.log('· voice off — no ELEVENLABS_API_KEY / SPEECH_ENGINE_ID in the repo .env (text still works)');
} else if (!wsUrl) {
  console.log('· voice off — HARNESS_PUBLIC_WS_URL not set (ElevenLabs dials IN, so it needs a public URL)');
} else if (flag('no-tunnel')) {
  console.log('· tunnel skipped (--no-tunnel)');
} else {
  const origin = wsUrl.replace(/^wss:/, 'https:').replace(/\/[^/]*$/, '');
  const host = new URL(origin).host;

  await waitFor(`http://localhost:${port}/api/state`, 30);

  if (await reachable(`${origin}/api/state`)) {
    console.log(`· tunnel already up → ${origin}`);
  } else {
    try {
      execFileSync('which', ['ngrok'], { stdio: 'ignore' });
    } catch {
      console.log(`· ⚠ ngrok not installed — voice needs ${origin} to reach this process (brew install ngrok)`);
    }
    tunnel = spawn('ngrok', ['http', String(port), '--url', host, '--log', 'stdout'], { stdio: 'ignore' });
    tunnel.on('error', () => console.log('· ⚠ could not start ngrok'));
    if (await waitFor(`${origin}/api/state`, 20)) {
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
const stop = () => {
  if (stopping) return;
  stopping = true;
  tunnel?.kill('SIGTERM');
  harness.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
harness.on('exit', (code) => {
  tunnel?.kill('SIGTERM');
  process.exit(code ?? 0);
});
