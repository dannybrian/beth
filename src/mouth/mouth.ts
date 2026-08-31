// The mouth as a LIBRARY — the counterpart of src/ear/, cut along the same
// seam (docs/ear.md, "the whole stack, not just the ear").
//
// This is everything speech-out that is not harness-shaped: the held-line
// queue, the TTS stream, voice/model resolution and its cache, audio-tag
// stripping, and the character bill. Credentials are a plain injected config;
// "a line exists" is one callback. What stays OUTSIDE, in src/speakOut.ts:
// the conversation-bus subscription, the speech LEVEL and its excerpting
// (spoken.ts), and every publish — another project brings its own versions of
// those, and the mouth does not know they exist.
//
// The lift-out set is this directory PLUS the text pipeline it names:
// audioTags.ts and markdown.ts (clean as a pair — markdown also serves the
// transcript, which is why it is not moved in here). The adapter additionally
// wants spoken.ts. Nothing else.
//
// She speaks when SHE has something to say. Speech Engine could only carry a
// response to something it HEARD — every volunteered line waited on a
// transcript, or forever. This is the way out that worked: hold the line,
// stream it as audio over loopback, let the page play it. Nothing dials in.
import { forVoice } from '../audioTags.ts';

export type HeldLine = { id: string; text: string; at: number };

export interface MouthConfig {
  /** Voice is optional — an absent key degrades the owner to text-only. */
  apiKey?: string;
  /** The machine's default voice; setVoice() overrides it per person. */
  voiceId?: string;
  /**
   * A Speech Engine id survives as ONE thing: somewhere to read a voice id
   * from, so an old setup keeps sounding like the same person. voiceId makes
   * it unnecessary.
   */
  speechEngineId?: string;
  ttsModel: string;
  /** Dollars per 1k credits, for the estimate. The plan sets it; no API says. */
  usdPer1kCredits: number;
}

/**
 * Lines are held only long enough for the page to fetch them. A page that never
 * asks (closed tab, refresh mid-line) must not leak the queue — and audio nobody
 * requested within a few minutes is news that has passed anyway.
 */
const HOLD_MS = 5 * 60_000;
/** Backstop against an unattended run filling memory with unplayed audio. */
const HOLD_MAX = 64;

export class Mouth {
  private cfg: MouthConfig;
  /** "There is a line to play, here is its id." The one outbound signal. */
  private onLine: (line: { id: string; chars: number }) => void;
  private held = new Map<string, HeldLine>();
  private seq = 0;
  private client: any = null;
  private resolved: { voiceId: string; modelId: string } | null = null;
  private resolving: Promise<{ voiceId: string; modelId: string }> | null = null;
  /** Reported upward so a missing permission is legible rather than silent. */
  lastError: string | null = null;

  /**
   * The VOICE of whoever is currently the director, overriding the machine's.
   *
   * A voice belongs to a person, and the machine-level voiceId is the default
   * rather than the truth — one account per Mac was always about the ACCOUNT,
   * not about there being one director. Null means nobody has been chosen and
   * the machine's own id stands.
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
   * Never reset. Clearing a conversation drops context; it does not refund
   * anything, and a cost meter that forgets is worse than no meter.
   */
  private billed = { lines: 0, chars: 0 };

  constructor(cfg: MouthConfig, onLine: (line: { id: string; chars: number }) => void) {
    this.cfg = cfg;
    this.onLine = onLine;
  }

  /** Needs a key and SOMEWHERE to get a voice id from — the engine counts. */
  get configured(): boolean {
    return Boolean(this.cfg.apiKey && (this.personaVoice || this.cfg.voiceId || this.cfg.speechEngineId));
  }

  /** Why she cannot speak, in words the page can put on the mic button. */
  get unavailableReason(): string | null {
    if (this.configured) return null;
    if (!this.cfg.apiKey) return 'no ELEVENLABS_API_KEY — the harness is text-only';
    return 'no HARNESS_VOICE_ID and no SPEECH_ENGINE_ID to read one from';
  }

  /**
   * Audio tags are an Eleven v3 feature and this path usually runs a realtime
   * model, which would read "[laughs]" out as a word. Derived from the model
   * actually in use rather than from any engine's, because they are not the
   * same model — that difference is a finding, not an accident.
   */
  private get tagsSupported(): boolean {
    return /v3/i.test(this.resolved?.modelId ?? this.cfg.ttsModel);
  }

  /**
   * Hand a line to the caller. Returns the id, or null when there is nothing
   * speakable left after tag-stripping, or when the mouth is unavailable.
   *
   * No queue, no staleness window, no waiting: the caller is told immediately
   * and the audio is fetched when someone wants it.
   */
  speak(raw: string): string | null {
    if (!this.configured) return null;
    const text = forVoice(raw ?? '', this.tagsSupported).trim();
    if (!text) return null;
    const id = `s${++this.seq}`;
    this.held.set(id, { id, text, at: Date.now() });
    this.sweep();
    // Only the id and a length travel; the owner's transcript already carries
    // the words, and shipping them twice invites a copy that can drift.
    this.onLine({ id, chars: text.length });
    return id;
  }

  /** Drop anything nobody asked for. Called on every new line. */
  private sweep() {
    const cutoff = Date.now() - HOLD_MS;
    for (const [id, line] of this.held) if (line.at < cutoff) this.held.delete(id);
    while (this.held.size > HOLD_MAX) this.held.delete(this.held.keys().next().value as string);
  }

  /**
   * What is actually speaking right now.
   *
   * There was a `voices()` beside this — the account's list, for a picker in
   * the page. Both are gone (2026-08-31): a voice belongs to a persona, named
   * by the `voice:` line in her file, so a picker could only ever audition one
   * and then forget it. `setVoice` stays because the PERSONA switch calls it.
   */
  currentVoice = () => this.personaVoice || this.cfg.voiceId || this.resolved?.voiceId || '';

  /** The text behind an id, without consuming it — a reload may re-request it. */
  textFor(id: string): string | null {
    return this.held.get(id)?.text ?? null;
  }

  private async getClient() {
    if (this.client) return this.client;
    const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
    this.client = new ElevenLabsClient({ apiKey: this.cfg.apiKey });
    return this.client;
  }

  /**
   * Point the mouth at a different voice.
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

  /**
   * Which voice, and which model.
   *
   * The VOICE is inherited from the Speech Engine when it is not configured
   * directly, because old and new paths have to sound like the same person. The
   * MODEL deliberately is not: `eleven_v3_conversational` is rejected by the
   * standalone text-to-speech endpoint, and a realtime model is the right
   * choice for a channel where first-byte latency is the whole experience.
   */
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
   * Audio for a held line, as a web ReadableStream the owner pipes out.
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
   * tag support — and for the same reason.
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
   * a figure you can check beats a figure you have to trust.
   */
  spend() {
    const credits = this.billed.chars * this.creditsPerChar;
    return {
      available: this.configured,
      lines: this.billed.lines,
      chars: this.billed.chars,
      credits,
      usd: (credits / 1000) * this.cfg.usdPer1kCredits,
      model: this.resolved?.modelId ?? this.cfg.ttsModel,
      creditsPerChar: this.creditsPerChar,
      usdPer1kCredits: this.cfg.usdPer1kCredits,
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
