#!/usr/bin/env node
// Throwaway spike for docs/voice-plane.md step 1. NOT part of the harness: its
// own port, its own server, no imports from src/. Delete the directory when the
// questions below are answered.
//
// It answers three things design cannot:
//   1. how badly an open mic hears HER through the speakers (the television problem)
//   2. what time-to-first-sound a plain HTTP TTS stream into <audio> actually gets
//   3. whether an AEC'd RMS meter is a good enough barge-in trigger while the
//      recogniser is parked
//
// Run:  node spike/voice-plane/serve.mjs [--harness 4620] [--port 4630]
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg('port', 4630));
const HARNESS = Number(arg('harness', 4620));

// --- config ------------------------------------------------------------------
// Same three layers as src/config.ts (real env → bound repo .env → machine file),
// re-read here rather than imported: loadConfig() insists on a bound repo, and a
// spike should not need one.
function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const repoEnv = readEnvFile(path.join(process.env.HARNESS_REPO ?? process.cwd(), '.env'));
const machineEnv = readEnvFile(path.join(os.homedir(), '.director-harness', '.env'));
const conf = (k) => process.env[k] ?? repoEnv[k] ?? machineEnv[k];

const API_KEY = conf('ELEVENLABS_API_KEY');
const ENGINE_ID = conf('SPEECH_ENGINE_ID');

let client = null;
let voice = null; // { voiceId, modelId, source }

async function getClient() {
  if (client) return client;
  const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
  client = new ElevenLabsClient({ apiKey: API_KEY });
  return client;
}

/**
 * Borrow the Speech Engine's own voice so the spike sounds like tonight's trace
 * rather than like a stranger — an echo test against a different voice is not
 * the same test. SPIKE_VOICE_ID wins, and is the escape hatch when the engine
 * cannot be read.
 */
async function resolveVoice() {
  if (voice) return voice;
  const override = conf('SPIKE_VOICE_ID');
  if (override) {
    voice = { voiceId: override, modelId: conf('SPIKE_TTS_MODEL') ?? 'eleven_flash_v2_5', source: 'SPIKE_VOICE_ID' };
    return voice;
  }
  const engine = await (await getClient()).speechEngine.get(ENGINE_ID);
  const tts = engine?.config?.tts ?? {};
  const voiceId = tts.voiceId ?? tts.voice_id;
  if (!voiceId) throw new Error('engine config has no tts.voiceId — set SPIKE_VOICE_ID');
  voice = {
    voiceId,
    // The engine runs Flash for realtime latency. Keeping its model means the
    // latency number below is comparable to what Speech Engine gets today.
    modelId: conf('SPIKE_TTS_MODEL') ?? tts.modelId ?? tts.model_id ?? 'eleven_flash_v2_5',
    source: `speech engine ${ENGINE_ID}`,
  };
  return voice;
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

// --- routes ------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return void res.end(fs.readFileSync(path.join(HERE, 'index.html')));
  }

  if (url.pathname === '/config') {
    let v = null;
    let reason = null;
    try {
      if (!API_KEY) throw new Error('no ELEVENLABS_API_KEY in env, repo .env or ~/.director-harness/.env');
      v = await resolveVoice();
    } catch (e) {
      reason = String(e?.message ?? e).slice(0, 300);
    }
    let harnessUp = false;
    try {
      harnessUp = (await fetch(`http://127.0.0.1:${HARNESS}/api/state`)).ok;
    } catch {
      /* not running — canned replies only, which is the repeatable mode anyway */
    }
    return json(res, 200, { voice: v, reason, harnessPort: HARNESS, harnessUp });
  }

  // Stream TTS straight into an <audio> element. No new transport: the browser's
  // own progressive buffering is the thing being tested.
  if (url.pathname === '/tts') {
    const text = url.searchParams.get('text') ?? '';
    if (!text.trim()) return json(res, 400, { error: 'empty text' });
    const t0 = performance.now();
    try {
      const v = await resolveVoice();
      const open = (modelId) =>
        getClient().then((c) =>
          c.textToSpeech.stream(v.voiceId, {
            text,
            modelId,
            outputFormat: 'mp3_44100_128',
            // 3 is "max latency optimisations" without disabling the text
            // normaliser — she says version numbers and file paths out loud.
            optimizeStreamingLatency: 3,
          })
        );
      let stream;
      try {
        stream = await open(v.modelId);
      } catch (e) {
        // The engine's own model is not guaranteed to exist on the standalone TTS
        // endpoint — a conversational build may only be reachable from inside a
        // session. Falling back keeps the spike answering its actual questions,
        // and the log says which voice you are hearing.
        if (/model/i.test(String(e?.body?.detail?.message ?? e?.message ?? e))) {
          console.log(`  tts: ${v.modelId} rejected — falling back to eleven_flash_v2_5`);
          v.modelId = 'eleven_flash_v2_5';
          stream = await open(v.modelId);
        } else throw e;
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
      let first = true;
      const node = Readable.fromWeb(stream);
      node.on('data', () => {
        if (!first) return;
        first = false;
        console.log(`  tts ttfb ${Math.round(performance.now() - t0)}ms  ${text.length} chars`);
      });
      node.on('error', (e) => {
        console.log(`  tts stream error — ${String(e).slice(0, 200)}`);
        res.destroy();
      });
      return void node.pipe(res);
    } catch (e) {
      // The most likely failure is the API key: the harness only ever needed the
      // "ElevenAgents" row, because Speech Engine does its own speaking. This
      // plane calls TTS directly, so the key needs Text to Speech as well — and
      // that is a finding, not a bug.
      const msg = String(e?.body?.detail?.message ?? e?.message ?? e).slice(0, 400);
      console.log(`  tts FAILED — ${msg}`);
      return json(res, 502, { error: msg, hint: /permission|unauthor|401|403/i.test(msg) ? 'the key needs the Text to Speech permission — Speech Engine never required it' : undefined });
    }
  }

  if (url.pathname === '/turn' && req.method === 'POST') {
    const body = await new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => resolve(JSON.parse(b || '{}')));
    });
    try {
      const r = await fetch(`http://127.0.0.1:${HARNESS}/api/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: String(body.text ?? '') }),
      });
      return json(res, r.status, await r.json());
    } catch (e) {
      return json(res, 502, { error: `harness on ${HARNESS} is not answering — ${String(e).slice(0, 160)}` });
    }
  }

  // SSE passthrough so the page can hear a REAL reply. Loopback to loopback; the
  // harness binds to 127.0.0.1 and this proxy must never be exposed either.
  if (url.pathname === '/stream') {
    try {
      const upstream = await fetch(`http://127.0.0.1:${HARNESS}/api/stream`);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      const node = Readable.fromWeb(upstream.body);
      node.pipe(res);
      req.on('close', () => node.destroy());
      return;
    } catch (e) {
      return json(res, 502, { error: String(e).slice(0, 200) });
    }
  }

  res.writeHead(404).end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  voice-plane spike  →  http://127.0.0.1:${PORT}`);
  console.log(`  harness proxy      →  127.0.0.1:${HARNESS} (canned replies work without it)`);
  console.log(`  credentials        →  ${API_KEY ? 'found' : 'MISSING — /tts will fail'}\n`);
});
