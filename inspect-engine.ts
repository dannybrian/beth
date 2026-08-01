import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
const el = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
const eng: any = await el.speechEngine.get(process.env.SPEECH_ENGINE_ID!);
console.log('stored config:', JSON.stringify(eng.config, null, 1));
