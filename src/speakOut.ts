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
import type { ConversationBus, UIMessage } from './bus.ts';
import { forVoice } from './audioTags.ts';
import { spokenFor, type SpeechLevel } from './spoken.ts';

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

  /** How much of what she writes is read aloud. See spoken.ts. */
  private verbosity: SpeechLevel;
  /**
   * The VOICE of whoever is currently the director, overriding the machine's.
   *
   * A voice belongs to a person, and the machine-level HARNESS_VOICE_ID is the
   * default rather than the truth — one account per Mac was always about the
   * ACCOUNT, not about there being one director. Null means nobody has been
   * chosen and the machine's own id stands.
   */
  private personaVoice: string | null = null;

  /**
   * What she has been BILLED for this run.
   *
   * Counted where the request is made, not where a line is held or played,
   * because that is the moment ElevenLabs charges: a line queued and never
   * fetched (closed tab, level turned down before it played) costs nothing, and
   * a page that re-requests one after a reload pays for it twice. Counting
   * `speak()` calls instead would report money that was never spent.
   *
   * Not reset by /clear. Clearing the conversation drops context; it does not
   * refund anything, and a cost meter that forgets is worse than no meter.
   */
  private billed = { lines: 0, chars: 0 };

  constructor(cfg: HarnessConfig, bus: ConversationBus) {
    this.cfg = cfg;
    this.bus = bus;
    this.verbosity = cfg.speechLevel;

    // The whole speech plane is this subscription. There is no turn to correlate
    // with, no session to be inside, and no in-flight response to avoid racing:
    // she says a line because she wrote one.
    bus.subscribe((m: UIMessage) => {
      if (m.type !== 'assistant' && m.type !== 'say') return;
      this.speak(
        spokenFor({ type: m.type, kind: m.type === 'say' ? m.kind : undefined, text: m.voiceText ?? m.text }, this.verbosity)
      );
    });
  }

  speechLevel = () => this.verbosity;

  setSpeechLevel(level: SpeechLevel) {
    this.verbosity = level;
    this.bus.publish({ type: 'speech', level });
  }

  /** Needs a key and SOMEWHERE to get a voice id from — the engine counts. */
  get configured(): boolean {
    return Boolean(this.cfg.elevenLabsApiKey && (this.personaVoice || this.cfg.voiceId || this.cfg.speechEngineId));
  }

  /** Why she cannot speak, in words the page can put on the mic button. */
  get unavailableReason(): string | null {
    if (this.configured) return null;
    if (!this.cfg.elevenLabsApiKey) return 'no ELEVENLABS_API_KEY — the harness is text-only';
    return 'no HARNESS_VOICE_ID and no SPEECH_ENGINE_ID to read one from';
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

  /**
   * The voices on this account, for the picker.
   *
   * Memoised for the life of the process: the list changes when Danny adds a
   * voice on elevenlabs.io, which is not something a page load should pay a
   * network round trip to notice. A failure is an EMPTY LIST rather than a
   * throw — no key, no permission, no network all mean the same thing here (no
   * picker), and none of them should turn into an error card on a page that is
   * otherwise working.
   */
  private voiceList: { id: string; name: string }[] | null = null;

  async voices(): Promise<{ id: string; name: string }[]> {
    if (this.voiceList) return this.voiceList;
    if (!this.cfg.elevenLabsApiKey) return [];
    try {
      const res: any = await (await this.getClient()).voices.search({ pageSize: 100 });
      this.voiceList = (res?.voices ?? [])
        .map((v: any) => ({ id: v.voiceId ?? v.voice_id, name: v.name ?? '(unnamed)' }))
        .filter((v: any) => v.id)
        .sort((a: any, b: any) => a.name.localeCompare(b.name));
      return this.voiceList!;
    } catch (e) {
      // Worth saying once — a picker that is silently empty looks like a bug in
      // the picker rather than a key without the right permission.
      console.log(`  voices: could not list (${e instanceof Error ? e.message : e})`);
      return [];
    }
  }

  /** What is actually speaking right now, so the picker can show it. */
  currentVoice = () => this.personaVoice || this.cfg.voiceId || this.resolved?.voiceId || '';

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
  /**
   * Point the plane at a different voice.
   *
   * ⚠️ The resolution is CACHED — the whole point of `resolved` is not asking
   * ElevenLabs which voice an engine uses on every line — so changing the voice
   * without dropping that cache changes nothing audible, and the failure is that
   * the new director sounds exactly like the old one. There is nothing to notice
   * except a wrong voice, which reads as the switch not having worked.
   */
  setVoice = (voiceId: string | null) => {
    if (this.personaVoice === voiceId) return;
    this.personaVoice = voiceId;
    this.resolved = null;
    this.resolving = null;
  };

  private async resolve(): Promise<{ voiceId: string; modelId: string }> {
    if (this.resolved) return this.resolved;
    if (this.resolving) return this.resolving;
    this.resolving = (async () => {
      let voiceId = this.personaVoice || this.cfg.voiceId;
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
      this.billed.lines += 1;
      this.billed.chars += line.text.length;
      return stream;
    } catch (e: any) {
      this.lastError = String(e?.body?.detail?.message ?? e?.message ?? e).slice(0, 300);
      throw e;
    }
  }

  /**
   * Credits per character, which is the half of the price ElevenLabs sets by
   * MODEL: the realtime models (flash, turbo) bill at half rate, everything else
   * at one credit per character. Derived from the model actually in use, like
   * tag support — and for the same reason, since the engine's model is not ours.
   */
  private get creditsPerChar(): number {
    return /flash|turbo/i.test(this.resolved?.modelId ?? this.cfg.ttsModel) ? 0.5 : 1;
  }

  /**
   * The speech bill for this run.
   *
   * Characters are EXACT — we sent them. The money is an ESTIMATE, because the
   * other half of the price is the plan, which the API does not hand us as a
   * rate. So the assumed rate travels with the number and the page prints it:
   * a figure you can check beats a figure you have to trust, and
   * HARNESS_TTS_USD_PER_1K_CREDITS is how you correct it.
   */
  spend() {
    const credits = this.billed.chars * this.creditsPerChar;
    return {
      available: this.configured,
      lines: this.billed.lines,
      chars: this.billed.chars,
      credits,
      usd: (credits / 1000) * this.cfg.ttsUsdPer1kCredits,
      model: this.resolved?.modelId ?? this.cfg.ttsModel,
      creditsPerChar: this.creditsPerChar,
      usdPer1kCredits: this.cfg.ttsUsdPer1kCredits,
    };
  }

  status() {
    return {
      available: this.configured,
      reason: this.unavailableReason,
      voiceId: this.resolved?.voiceId ?? this.cfg.voiceId ?? null,
      model: this.resolved?.modelId ?? this.cfg.ttsModel,
      held: this.held.size,
      error: this.lastError,
    };
  }
}
