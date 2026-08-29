// The harness's adapter onto the mouth library — the counterpart of earHost.ts,
// and deliberately OUTSIDE src/mouth/, which is the liftable unit and must not
// know this harness exists.
//
// What lives here is everything conversation-shaped: the ONE subscription that
// IS the speech plane (she says a line because she wrote one — no turn to
// correlate with, no session to be inside), the speech LEVEL and its excerpting
// (spoken.ts — the page and the ear have different budgets), and every bus
// publish. The mouth itself — held lines, the TTS stream, voice resolution,
// tag stripping, the bill — is src/mouth/mouth.ts, with credentials injected
// and "there is a line to play" as one callback.
//
// The public surface is unchanged from when this WAS the whole plane: main.ts
// passes setVoice and speechLevel around by reference, and server.ts calls the
// rest. Behaviour changes here are a bug.
import type { HarnessConfig } from './config.ts';
import type { ConversationBus, UIMessage } from './bus.ts';
import { Mouth } from './mouth/mouth.ts';
import { spokenFor, type SpeechLevel } from './spoken.ts';

export type { HeldLine } from './mouth/mouth.ts';

export class SpeakOut {
  private mouth: Mouth;
  private bus: ConversationBus;
  /** How much of what she writes is read aloud. See spoken.ts. */
  private verbosity: SpeechLevel;

  constructor(cfg: HarnessConfig, bus: ConversationBus) {
    this.bus = bus;
    this.verbosity = cfg.speechLevel;
    this.mouth = new Mouth(
      {
        apiKey: cfg.elevenLabsApiKey,
        voiceId: cfg.voiceId,
        speechEngineId: cfg.speechEngineId,
        ttsModel: cfg.ttsModel,
        usdPer1kCredits: cfg.ttsUsdPer1kCredits,
      },
      // The page only needs the id; `chars` lets it show progress without
      // shipping the line twice, since the transcript already carries the words.
      ({ id, chars }) => bus.publish({ type: 'speak', id, chars })
    );

    // The whole speech plane is this subscription. There is no turn to correlate
    // with, no session to be inside, and no in-flight response to avoid racing:
    // she says a line because she wrote one.
    bus.subscribe((m: UIMessage) => {
      if (m.type !== 'assistant' && m.type !== 'say') return;
      this.mouth.speak(
        spokenFor({ type: m.type, kind: m.type === 'say' ? m.kind : undefined, text: m.voiceText ?? m.text }, this.verbosity)
      );
    });
  }

  speechLevel = () => this.verbosity;

  setSpeechLevel(level: SpeechLevel) {
    this.verbosity = level;
    this.bus.publish({ type: 'speech', level });
  }

  // --- the mouth, delegated ---------------------------------------------------
  // Arrow properties where main.ts passes the method around by reference.

  get configured() {
    return this.mouth.configured;
  }

  get unavailableReason() {
    return this.mouth.unavailableReason;
  }

  get lastError() {
    return this.mouth.lastError;
  }

  speak(raw: string): string | null {
    return this.mouth.speak(raw);
  }

  textFor(id: string): string | null {
    return this.mouth.textFor(id);
  }

  stream(id: string): Promise<ReadableStream<Uint8Array>> {
    return this.mouth.stream(id);
  }

  voices() {
    return this.mouth.voices();
  }

  setVoice = (voiceId: string | null) => this.mouth.setVoice(voiceId);

  currentVoice = () => this.mouth.currentVoice();

  spend() {
    return this.mouth.spend();
  }

  status() {
    return this.mouth.status();
  }
}
