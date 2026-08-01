// What can this API key actually reach? Speech Engine needs more than TTS/STT.
// Usage: ELEVENLABS_API_KEY=... node probe-key.ts
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) {
  console.error('set ELEVENLABS_API_KEY');
  process.exit(1);
}
const el = new ElevenLabsClient({ apiKey });

const check = async (label: string, fn: () => Promise<unknown>) => {
  try {
    const r = await fn();
    console.log(`✅ ${label}`);
    return r;
  } catch (e: any) {
    const msg = e?.statusCode ? `${e.statusCode} ${JSON.stringify(e.body ?? {}).slice(0, 200)}` : String(e).slice(0, 200);
    console.log(`❌ ${label} — ${msg}`);
    return null;
  }
};

// Identity / plan
const sub = (await check('user.subscription.get', () => el.user.subscription.get())) as any;
if (sub) console.log(`   tier=${sub.tier} chars=${sub.characterCount}/${sub.characterLimit}`);

// Speech Engine — the one that matters
const engines = (await check('speechEngine.list', () => (el.speechEngine as any).list())) as any;
if (engines) console.log('   engines:', JSON.stringify(engines).slice(0, 600));

// Token minting for the browser
await check('conversationalAi.conversations.getWebrtcToken', () =>
  (el as any).conversationalAi.conversations.getWebrtcToken({
    agentId: process.env.SPEECH_ENGINE_ID ?? 'seng_unknown',
  })
);

console.log('\nSpeech Engine methods available on the client:');
console.log(' ', Object.getOwnPropertyNames(Object.getPrototypeOf((el as any).speechEngine ?? {})).join(', '));
