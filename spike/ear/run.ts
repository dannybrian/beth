// The ear spike. See docs/ear.md, step 1.
//
// Answers, against the real service:
//   1. Does a single-use token satisfy the websocket, so node's NATIVE WebSocket
//      works and `ws` stays deleted? (Which token endpoint is real, while at it.)
//   2. What do the frames actually look like — captured VERBATIM into fixtures/,
//      because an invented fixture is worth what the invented node---test one was.
//   3. Does VAD commit fire on trailing silence, and how late after the speech?
//   4. Do keyterms change what it hears? The test audio is ElevenLabs' own TTS
//      saying project nouns, so the round trip needs no microphone.
//
// Run:  node spike/ear/run.ts
// Cost: a few hundred TTS characters and under a minute of STT. Cents.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIXTURES = path.join(HERE, 'fixtures');
fs.mkdirSync(FIXTURES, { recursive: true });

// ---- config, the harness's own layering in miniature ------------------------

function parseEnvFile(p: string): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

const machineEnv = parseEnvFile(path.join(os.homedir(), '.director-harness', '.env'));
const KEY = process.env.ELEVENLABS_API_KEY ?? machineEnv.ELEVENLABS_API_KEY;
if (!KEY) {
  console.error('No ELEVENLABS_API_KEY in env or ~/.director-harness/.env');
  process.exit(1);
}

const API = 'https://api.elevenlabs.io';
const WSS = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const MODEL = 'scribe_v2_realtime';
const TTS_MODEL = 'eleven_flash_v2_5';

/**
 * What the audio SAYS. Chosen to exercise exactly what the Web Speech path
 * cannot do: "the settle period" is the sentence the dictation table eats,
 * the question mark must arrive as punctuation, and the nouns are the ones
 * reported mangled from use (pnpm came back wrong, colyseus came back
 * "colossus").
 */
const SCRIPT_TEXT =
  "Let's check the settle period. Does pnpm work with colyseus? Open beadgame, then run the tests.";
const KEYTERMS = ['pnpm', 'colyseus', 'beadgame', 'tulito'];

const findings: string[] = [];
function finding(s: string) {
  findings.push(s);
  console.log(`\n★ ${s}\n`);
}

// ---- fixture capture --------------------------------------------------------

function recorder(name: string) {
  const file = path.join(FIXTURES, name);
  fs.writeFileSync(file, '');
  return (entry: Record<string, unknown>) => {
    fs.appendFileSync(file, JSON.stringify({ t: Date.now(), ...entry }) + '\n');
  };
}

// ---- step 1: mint a single-use token ---------------------------------------

async function mintToken(): Promise<string | null> {
  // Two candidate endpoints appear in the docs; try both, record which is real.
  const candidates: Array<[string, RequestInit]> = [
    [`${API}/v1/single-use-token/realtime_scribe`, { method: 'POST' }],
    [
      `${API}/v1/speech-to-text/get-realtime-token`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model_id: MODEL }) },
    ],
  ];
  for (const [url, init] of candidates) {
    const res = await fetch(url, { ...init, headers: { 'xi-api-key': KEY, ...(init.headers ?? {}) } });
    const body = await res.text();
    console.log(`token mint ${url} → ${res.status} ${body.slice(0, 300)}`);
    if (res.ok) {
      finding(`Token endpoint is ${url} (HTTP ${res.status}).`);
      try {
        const j = JSON.parse(body);
        const token = j.token ?? j.single_use_token ?? j.value ?? null;
        if (token) return token as string;
        finding(`Token response had no obvious token field: keys = ${Object.keys(j).join(', ')}`);
      } catch {
        // A bare string body would be surprising but not impossible.
        if (body.length > 10 && body.length < 2048) return body.replace(/^"|"$/g, '');
      }
    }
    if (res.status === 401 || res.status === 403) {
      finding(
        `Key REFUSED for realtime STT (${res.status}) at ${url} — likely the speech_to_text permission is missing on the key. Body: ${body.slice(0, 200)}`
      );
    }
  }
  return null;
}

// ---- step 2: synthesize the test audio as pcm_16000 ------------------------

async function synthAudio(): Promise<Buffer> {
  const cached = path.join(FIXTURES, 'script-audio-pcm16k.raw');
  if (fs.existsSync(cached) && fs.statSync(cached).size > 0) {
    console.log(`using cached TTS audio (${fs.statSync(cached).size} bytes)`);
    return fs.readFileSync(cached);
  }
  // The key is scoped to TTS only (voices_read 401s — see CLAUDE.md), so no
  // listing: a premade voice id works on every account, and WHICH voice reads
  // the script is irrelevant to what Scribe hears back.
  const voiceId = process.env.SPIKE_VOICE_ID ?? machineEnv.HARNESS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM';
  const res = await fetch(`${API}/v1/text-to-speech/${voiceId}?output_format=pcm_16000`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text: SCRIPT_TEXT, model_id: TTS_MODEL }),
  });
  if (!res.ok) throw new Error(`TTS → ${res.status} ${(await res.text()).slice(0, 200)}`);
  const pcm = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(cached, pcm);
  console.log(`TTS audio: ${pcm.length} bytes = ${(pcm.length / 2 / 16000).toFixed(1)}s`);
  return pcm;
}

// ---- step 3: stream a run against the websocket ----------------------------

type RunOpts = {
  name: string;
  token: string;
  pcm: Buffer;
  keyterms?: string[];
  keytermsEncoding?: 'json' | 'repeat';
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function scribeRun(opts: RunOpts) {
  const record = recorder(`${opts.name}.jsonl`);
  const params = new URLSearchParams({
    model_id: MODEL,
    token: opts.token,
    audio_format: 'pcm_16000',
    commit_strategy: 'vad',
  });
  if (opts.keyterms?.length) {
    if (opts.keytermsEncoding === 'repeat') for (const k of opts.keyterms) params.append('keyterms', k);
    else params.set('keyterms', JSON.stringify(opts.keyterms));
  }
  const url = `${WSS}?${params}`;
  record({ dir: 'meta', url: url.replace(opts.token, '<token>') });
  console.log(`\n=== run ${opts.name} ===`);

  const ws = new WebSocket(url);
  const partials: string[] = [];
  let committed = '';
  let sessionStarted: unknown = null;
  let closed: { code: number; reason: string } | null = null;
  let lastAudioSentAt = 0;
  let commitAt = 0;
  let firstPartialAt = 0;
  let openAt = 0;

  const done = new Promise<void>((resolve) => {
    ws.addEventListener('open', () => {
      openAt = Date.now();
      record({ dir: 'event', event: 'open' });
    });
    ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString();
      record({ dir: 'recv', frame: safeJson(raw) });
      const msg = safeJson(raw) as any;
      const type = msg?.message_type ?? msg?.type;
      if (type === 'session_started') sessionStarted = msg;
      if (String(type).includes('partial')) {
        if (!firstPartialAt) firstPartialAt = Date.now();
        partials.push(msg.text ?? '');
      }
      if (String(type).includes('committed') && msg.text) {
        committed = msg.text;
        commitAt = Date.now();
      }
    });
    ws.addEventListener('error', () => record({ dir: 'event', event: 'error' }));
    ws.addEventListener('close', (ev) => {
      closed = { code: ev.code, reason: ev.reason };
      record({ dir: 'event', event: 'close', code: ev.code, reason: ev.reason });
      resolve();
    });
  });

  // Wait for open (or an early close, which is what a rejected handshake looks like).
  await Promise.race([done, new Promise<void>((r) => ws.addEventListener('open', () => r(), { once: true }))]);
  if (closed) {
    console.log(`handshake rejected: ${JSON.stringify(closed)}`);
    return { partials, committed, sessionStarted, closed, vadLatencyMs: 0, ttfpMs: 0 };
  }

  // Stream in realtime pacing: 250ms chunks, so VAD sees speech shaped like speech.
  const BYTES_PER_CHUNK = 16000 * 2 * 0.25;
  for (let off = 0; off < opts.pcm.length; off += BYTES_PER_CHUNK) {
    if (closed) break;
    const chunk = opts.pcm.subarray(off, off + BYTES_PER_CHUNK);
    ws.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: chunk.toString('base64'),
        sample_rate: 16000,
        commit: false,
      })
    );
    lastAudioSentAt = Date.now();
    // Sends are summarized, not recorded in full — fixtures are for RECEIVED frames.
    record({ dir: 'send', bytes: chunk.length });
    await sleep(250);
  }
  // Trailing silence, 3s worth, to hand VAD its endpoint.
  const silence = Buffer.alloc(BYTES_PER_CHUNK);
  for (let i = 0; i < 12 && !closed; i++) {
    ws.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: silence.toString('base64'),
        sample_rate: 16000,
        commit: false,
      })
    );
    record({ dir: 'send', bytes: silence.length, silence: true });
    await sleep(250);
  }
  // Give the commit up to 8s past end of speech, then close.
  const deadline = Date.now() + 8000;
  while (!committed && !closed && Date.now() < deadline) await sleep(100);
  try {
    ws.close(1000);
  } catch {}
  await Promise.race([done, sleep(3000)]);

  const vadLatencyMs = commitAt && lastAudioSentAt ? commitAt - lastAudioSentAt : 0;
  const ttfpMs = firstPartialAt && openAt ? firstPartialAt - openAt : 0;
  console.log(`partials: ${partials.length}, first at +${ttfpMs}ms`);
  console.log(`committed: "${committed}"`);
  if (commitAt) console.log(`commit arrived ${vadLatencyMs}ms after last real audio chunk was sent`);
  return { partials, committed, sessionStarted, closed, vadLatencyMs, ttfpMs };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { unparsed: s.slice(0, 2000) };
  }
}

// ---- the spike --------------------------------------------------------------

const token = await mintToken();
if (!token) {
  console.error('\nNo token; cannot proceed. If this is the permission, the fix is a checkbox:');
  console.error('ElevenLabs → API keys → this key → enable Speech to Text.');
  process.exit(2);
}
finding('Node NATIVE WebSocket + query-param token is viable — no `ws` dependency needed for auth.');

const pcm = await synthAudio();

// Run A: the shape we would ship — VAD commits, keyterms on.
let a = await scribeRun({ name: 'vad-keyterms', token, pcm, keyterms: KEYTERMS });
if (a.closed && !a.sessionStarted) {
  // JSON-array keyterms refused at handshake? Retry the other encoding.
  const t2 = await mintToken();
  if (t2) a = await scribeRun({ name: 'vad-keyterms-repeat', token: t2, pcm, keyterms: KEYTERMS, keytermsEncoding: 'repeat' });
  if (a.sessionStarted) finding('keyterms encoding: REPEATED query params, not a JSON array.');
} else if (a.sessionStarted) {
  finding('keyterms encoding: JSON array in one query param was accepted.');
}

// Run B: same audio, no keyterms — the nouns are the diff.
const tB = await mintToken();
const b = tB ? await scribeRun({ name: 'vad-plain', token: tB, pcm }) : null;

// Run C: a bad token, for a REAL auth error fixture.
const c = await scribeRun({ name: 'auth-error', token: 'not-a-real-token', pcm: pcm.subarray(0, 8000) });

// ---- report -----------------------------------------------------------------

console.log('\n================ SPIKE REPORT ================');
for (const f of findings) console.log(`• ${f}`);
console.log(`\nScript text:     ${SCRIPT_TEXT}`);
console.log(`With keyterms:   ${a.committed || '(no commit)'}`);
if (b) console.log(`Without:         ${b.committed || '(no commit)'}`);
console.log(`VAD commit latency after speech end: keyterms=${a.vadLatencyMs}ms plain=${b?.vadLatencyMs}ms`);
console.log(`Time to first partial after open:    keyterms=${a.ttfpMs}ms plain=${b?.ttfpMs}ms`);
console.log(`Auth-error run closed with:          ${JSON.stringify(c.closed)}`);
console.log(`\nFixtures captured in ${FIXTURES}:`);
for (const f of fs.readdirSync(FIXTURES)) console.log(`  ${f} (${fs.statSync(path.join(FIXTURES, f)).size} bytes)`);
