// The outbound half of the voice plane: she speaks when SHE has something to say.
//
// Speech Engine can only carry a response to something it HEARD, so every line
// she wanted to volunteer waited for a transcript — 6 to 14 seconds for the
// recogniser to remark on an empty room, and forever if the mic was muted. Both
// documented ways out were tried against the real service and both failed (see
// docs/voice-plane.md). This is the way out that works: the harness holds the
// line, streams it as audio over loopback, and the page plays it.
//
// Nothing dials in. The stream is served by the LOCAL server, which is the whole
// security story — no tunnel, no public listener, no singleton.
import type { HarnessConfig } from './config.ts';
import type { ConversationBus } from './bus.ts';
import { forVoice } from './audioTags.ts';

export type HeldLine = { id: string; text: string; at: number };

/**
 * Lines are held only long enough for the page to fetch them. A page that never
 * asks (closed tab, refresh mid-line) must not leak the queue — and audio nobody
 * requested within a few minutes is news that has passed anyway.
 */
const HOLD_MS = 5 * 60_000;
/** Backstop against an unattended run filling memory with unplayed audio. */
const HOLD_MAX = 64;

export class SpeakOut {
  private cfg: HarnessConfig;
  private bus: ConversationBus;
  private held = new Map<string, HeldLine>();
  private seq = 0;
  private client: any = null;
  private resolved: { voiceId: string; modelId: string } | null = null;
  private resolving: Promise<{ voiceId: string; modelId: string }> | null = null;
  /** Reported to the page so a missing permission is legible rather than silent. */
  lastError: string | null = null;

  constructor(cfg: HarnessConfig, bus: ConversationBus) {
    this.cfg = cfg;
    this.bus = bus;
  }

  /** Needs a key and SOMEWHERE to get a voice id from — the engine counts. */
  get configured(): boolean {
    return Boolean(this.cfg.speakOut && this.cfg.elevenLabsApiKey && (this.cfg.voiceId || this.cfg.speechEngineId));
  }

  /**
   * Audio tags are an Eleven v3 feature and the speak-out path runs a realtime
   * model, which would read "[laughs]" out as a word. Derived from the model
   * actually in use rather than from the engine's, because they are not the same
   * model — that difference is a finding, not an accident.
   */
  private get tagsSupported(): boolean {
    return /v3/i.test(this.resolved?.modelId ?? this.cfg.ttsModel);
  }

  /**
   * Hand a line to the page. Returns the id, or null when there is nothing
   * speakable left after tag-stripping, or when speak-out is unavailable.
   *
   * Unlike the Speech Engine path there is no queue, no staleness window and no
   * waiting: the page is told immediately and plays when it can.
   */
  speak(raw: string): string | null {
    if (!this.configured) return null;
    const text = forVoice(raw ?? '', this.tagsSupported).trim();
    if (!text) return null;
    const id = `s${++this.seq}`;
    this.held.set(id, { id, text, at: Date.now() });
    this.sweep();
    // The page only needs the id; `chars` lets it show progress without shipping
    // the line twice, since the transcript already carries the words.
    this.bus.publish({ type: 'speak', id, chars: text.length });
    return id;
  }

  /** Drop anything the page never asked for. Called on every new line. */
  private sweep() {
    const cutoff = Date.now() - HOLD_MS;
    for (const [id, line] of this.held) if (line.at < cutoff) this.held.delete(id);
    while (this.held.size > HOLD_MAX) this.held.delete(this.held.keys().next().value as string);
  }

  /** The text behind an id, without consuming it — a reload may re-request it. */
  textFor(id: string): string | null {
    return this.held.get(id)?.text ?? null;
  }

  private async getClient() {
    if (this.client) return this.client;
    const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
    this.client = new ElevenLabsClient({ apiKey: this.cfg.elevenLabsApiKey });
    return this.client;
  }

  /**
   * Which voice, and which model.
   *
   * The VOICE is inherited from the Speech Engine when it is not configured
   * directly, because the two paths have to sound like the same person. The MODEL
   * deliberately is not: `eleven_v3_conversational` is rejected by the standalone
   * text-to-speech endpoint, and a realtime model is the right choice for a
   * channel where first-byte latency is the whole experience.
   */
  private async resolve(): Promise<{ voiceId: string; modelId: string }> {
    if (this.resolved) return this.resolved;
    if (this.resolving) return this.resolving;
    this.resolving = (async () => {
      let voiceId = this.cfg.voiceId;
      if (!voiceId) {
        const engine: any = await (await this.getClient()).speechEngine.get(this.cfg.speechEngineId);
        voiceId = engine?.config?.tts?.voiceId ?? engine?.config?.tts?.voice_id;
        if (!voiceId) throw new Error('no voice id — set HARNESS_VOICE_ID');
      }
      this.resolved = { voiceId, modelId: this.cfg.ttsModel };
      return this.resolved;
    })();
    try {
      return await this.resolving;
    } finally {
      this.resolving = null;
    }
  }

  /**
   * Audio for a held line, as a web ReadableStream the server pipes out.
   *
   * Throws with the service's own message rather than a generic failure: the one
   * that actually happens is the API key missing the `text_to_speech` permission,
   * because Speech Engine never needed it, and that is worth saying in as many
   * words.
   */
  async stream(id: string): Promise<ReadableStream<Uint8Array>> {
    const line = this.held.get(id);
    if (!line) throw new Error(`no held line ${id}`);
    const { voiceId, modelId } = await this.resolve();
    try {
      const stream = await (await this.getClient()).textToSpeech.stream(voiceId, {
        text: line.text,
        modelId,
        outputFormat: 'mp3_44100_128',
        // Max latency optimisation short of disabling the text normaliser — she
        // says version numbers and file paths out loud, and wants them read.
        optimizeStreamingLatency: 3,
      });
      this.lastError = null;
      return stream;
    } catch (e: any) {
      this.lastError = String(e?.body?.detail?.message ?? e?.message ?? e).slice(0, 300);
      throw e;
    }
  }

  status() {
    return {
      speakOut: this.configured,
      voiceId: this.resolved?.voiceId ?? this.cfg.voiceId ?? null,
      model: this.resolved?.modelId ?? this.cfg.ttsModel,
      held: this.held.size,
      error: this.lastError,
    };
  }
}
