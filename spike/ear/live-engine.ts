// End-to-end check of the SHIPPED engine (src/ear/scribeEngine.ts) against the
// real service — the same TTS round trip as run.ts, through the real class.
// Run: node spike/ear/live-engine.ts   (needs the cached script-audio from run.ts)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ScribeEngine } from '../../src/ear/scribeEngine.ts';

const envFile = path.join(os.homedir(), '.director-harness', '.env');
const key = process.env.ELEVENLABS_API_KEY ?? fs.readFileSync(envFile, 'utf8').match(/^ELEVENLABS_API_KEY=(.*)$/m)?.[1];
if (!key) throw new Error('no ELEVENLABS_API_KEY');
const pcmPath = new URL('./fixtures/script-audio-pcm16k.raw', import.meta.url);
const pcm = new Int16Array(new Uint8Array(fs.readFileSync(pcmPath)).buffer);

const engine = new ScribeEngine({ apiKey: key });
let commit = '';
let forwarded = 0;
const session = engine.start({
  keyterms: ['pnpm', 'colyseus', 'beadgame', 'tulito'],
  onPartial: (t) => console.log(`partial: ${t}`),
  onCommit: (t) => (commit = t),
  onState: (s, d) => console.log(`state: ${s}${d ? ` — ${d}` : ''}`),
  onAudioForwarded: (s) => (forwarded += s),
});

// Realtime pacing, 250ms parcels, then 3s of silence for the VAD endpoint.
const CHUNK = 4000;
for (let off = 0; off < pcm.length; off += CHUNK) {
  session.push(pcm.subarray(off, off + CHUNK));
  await new Promise((r) => setTimeout(r, 250));
}
for (let i = 0; i < 12 && !commit; i++) {
  session.push(new Int16Array(CHUNK));
  await new Promise((r) => setTimeout(r, 250));
}
const deadline = Date.now() + 8000;
while (!commit && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
await session.close();

console.log(`\ncommit:    ${commit || '(none)'}`);
console.log(`forwarded: ${forwarded.toFixed(1)}s`);
const expected = "Let's check the settle period. Does pnpm work with colyseus? Open beadgame, then run the tests.";
console.log(commit === expected ? 'VERBATIM ✓' : `≠ expected\n           ${expected}`);
