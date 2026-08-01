// VoiceService — the speech plane.
//
// Shape (ElevenLabs Speech Engine, bring-your-own-LLM):
//   browser  ──WebRTC──►  ElevenLabs  ──WebSocket──►  this harness
// ElevenLabs does ears and mouth only. Every word of conversation logic, tool
// calling, and context stays in our director session.
//
// Cost is the constraint: Speech Engine bills CONNECTION duration, not audio
// processed (~$0.24/hr even idle, past the 10 s silence discount). So sessions are
// demand-scoped — the browser's free local VAD decides when a paid session should
// exist, and this service just reports what it costs while it lives.
import type { Server } from 'node:http';
import type { ConversationBus, UIMessage } from './bus.ts';
import type { SessionManager } from './session.ts';
import type { HarnessConfig } from './config.ts';
import { forVoice, isMeaningfulUtterance } from './audioTags.ts';

export const RATE_PER_MINUTE = 0.08;
/** Path ElevenLabs connects to. The engine's wsUrl must end with this. */
export const VOICE_WS_PATH = '/voice-ws';
/** Silences past this get a 95% discount, per ElevenLabs voice-call billing. */
const SILENCE_DISCOUNT_AFTER_S = 10;
const SILENCE_RATE_MULTIPLIER = 0.05;

type Transcript = { role: string; content: string }[];

export class VoiceService {
  private cfg: HarnessConfig;
  private bus: ConversationBus;
  private session: SessionManager;
  private client: any = null;
  private attachment: any = null;
  private attached = false;
  private connectedAt: number | null = null;
  /** Effective tag support — config, narrowed by what the engine's model can do. */
  private tagsSupported = true;
  /** The live session, so text Danny TYPED can still be spoken. */
  private liveSession: any = null;
  /** True while a spoken turn is streaming, so we don't double-speak it. */
  private turnActive = false;
  private lastActivityAt = 0;
  private accruedUsd = 0;

  constructor(cfg: HarnessConfig, bus: ConversationBus, session: SessionManager) {
    this.cfg = cfg;
    this.bus = bus;
    this.session = session;
    session.voiceActive = () => this.connectedAt !== null;

    // Speak turns Danny TYPED. A transcript-driven turn already streams its own
    // text through runTurn(), so this only fires when no such turn is in flight —
    // otherwise every line would be spoken twice.
    bus.subscribe((m: UIMessage) => {
      if (m.type !== 'assistant' && m.type !== 'say') return;
      if (this.turnActive || !this.liveSession) return;
      const text = forVoice(m.voiceText ?? m.text, this.cfg.audioTagsSupported && this.tagsSupported).trim();
      if (!text) return;
      this.lastActivityAt = Date.now();
      Promise.resolve(this.liveSession.sendResponse(text)).catch(() => {
        /* session may have closed underneath us */
      });
    });
  }

  get configured() {
    return Boolean(this.cfg.elevenLabsApiKey && this.cfg.speechEngineId);
  }

  /** Why voice is unavailable, in words Danny can act on. */
  get unavailableReason(): string | null {
    if (this.cfg.elevenLabsApiKey && this.cfg.speechEngineId) return null;
    const missing = [
      !this.cfg.elevenLabsApiKey && 'ELEVENLABS_API_KEY',
      !this.cfg.speechEngineId && 'SPEECH_ENGINE_ID (create a Speech Engine in the ElevenLabs dashboard; it looks like seng_…)',
    ].filter(Boolean);
    return `Voice is off — missing ${missing.join(' and ')}.`;
  }

  /**
   * Attach the Speech Engine websocket handler to the harness's own HTTP server.
   * No-op (and no crash) when unconfigured — the harness stays fully usable as text.
   */
  async attach(server: Server) {
    if (!this.configured) {
      console.log(`  voice: ${this.unavailableReason}`);
      return;
    }
    const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
    this.client = new ElevenLabsClient({ apiKey: this.cfg.elevenLabsApiKey });

    // ElevenLabs DIALS IN to us — it is the websocket client, we are the server
    // (the reverse of every other ElevenLabs API). So the engine's wsUrl must be a
    // publicly reachable address for this process. With a tunnel whose hostname
    // rotates, point HARNESS_PUBLIC_WS_URL at the current one and the harness
    // re-registers itself on boot instead of making you edit the dashboard.
    //
    // NOTE: wsUrl is NESTED under `speechEngine`. Passing it at the top level is
    // accepted and silently ignored — the update "succeeds" and changes nothing,
    // which is why this now reads the config back instead of trusting the write.
    if (this.cfg.publicWsUrl) {
      try {
        await this.client.speechEngine.update(this.cfg.speechEngineId, {
          speechEngine: { wsUrl: this.cfg.publicWsUrl },
        });
      } catch (e) {
        console.log(`  voice: could not update wsUrl — ${String(e).slice(0, 160)}`);
      }
    }

    // Read the engine back: the stored wsUrl decides which path ElevenLabs will
    // request, so derive the listen path from it rather than assuming they agree.
    let listenPath = VOICE_WS_PATH;
    try {
      const engine: any = await this.client.speechEngine.get(this.cfg.speechEngineId);
      const stored: string = engine?.config?.speechEngine?.wsUrl ?? '';
      if (stored) {
        const p = new URL(stored).pathname;
        listenPath = p && p !== '/' ? p : '/';
        console.log(`  voice: engine wsUrl = ${stored} → listening on ${listenPath}`);
        if (listenPath === '/') {
          console.log('  voice: ⚠ wsUrl has no path; accepting upgrades at / (the UI still serves normally)');
        }
      }

      // Audio tags are an Eleven v3 feature. Realtime engines default to Flash for
      // latency, which reads "[laughs]" as words. Detect and disable rather than
      // let the voice narrate stage directions.
      const modelId: string = engine?.config?.tts?.modelId ?? '';
      if (modelId && !/v3/i.test(modelId) && this.cfg.audioTagsSupported) {
        this.tagsSupported = false;
        console.log(`  voice: tts model ${modelId} predates v3 audio tags — tags will be stripped from speech`);
      }
    } catch (e) {
      console.log(`  voice: could not read engine config — ${String(e).slice(0, 160)}`);
    }

    // attach() is synchronous and returns a handle whose .close() detaches
    // without touching the HTTP server. It also verifies the inbound
    // X-Elevenlabs-Speech-Engine-Authorization JWT on every upgrade, so exposing
    // this path through a tunnel is not an open door.
    this.attachment = this.client.speechEngine.attach(this.cfg.speechEngineId, server, listenPath, {
      // Logs accepted/rejected upgrades. Worth the noise until a real ElevenLabs
      // connection has been seen at least once.
      debug: true,
      onInit: (conversationId: string) => {
        this.connectedAt = Date.now();
        this.lastActivityAt = Date.now();
        this.publishVoice('connected', `voice session ${String(conversationId).slice(0, 12)}…`);
      },
      onTranscript: (transcript: Transcript, signal: AbortSignal, session: any) => {
        this.lastActivityAt = Date.now();
        // Barge-in: Speech Engine aborts the in-flight response when Danny speaks
        // over it. That is exactly our interrupt semantics, so forward it.
        signal.addEventListener('abort', () => {
          void this.session.interrupt();
        });
        this.liveSession = session;
        const utterance = [...transcript].reverse().find((m) => m.role === 'user')?.content ?? '';
        // Silence transcribes as "..." — never spend a Claude turn on it.
        if (!isMeaningfulUtterance(utterance)) {
          this.bus.publish({ type: 'voice', state: 'ignored', detail: utterance.trim(), status: this.status() });
          return;
        }
        this.turnActive = true;
        session.sendResponse(this.runTurn(utterance)).finally(() => {
          this.turnActive = false;
        });
      },
      onClose: () => {
        this.liveSession = null;
        this.endSession();
      },
      onError: (err: unknown) => {
        this.publishVoice('error', String(err).slice(0, 200));
      },
    });
    this.attached = true;
    console.log(`  voice: Speech Engine attached at ${VOICE_WS_PATH} (engine ${this.cfg.speechEngineId})`);
    if (!this.cfg.publicWsUrl) {
      console.log(
        `  voice: ⚠ ElevenLabs must reach this process from the internet — set the engine's wsUrl to wss://<public-host>${VOICE_WS_PATH}`
      );
    }
  }

  /** Stop accepting Speech Engine connections without closing the HTTP server. */
  close() {
    this.attachment?.close?.();
  }

  /**
   * Push the utterance into the live director session and stream that turn's
   * spoken text back to ElevenLabs as it arrives.
   *
   * The seam is the bus, not the SDK stream: `say` items and ordinary reply text
   * both reach Danny's ears, in the order they were produced, and the turn ends
   * when the session reports idle. Tapping the bus also means a turn Danny started
   * by TYPING still gets spoken if a voice session happens to be open.
   */
  private runTurn(utterance: string): AsyncIterable<string> {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    let done = false;

    const push = (s: string) => {
      const text = forVoice(s, this.cfg.audioTagsSupported && this.tagsSupported).trim();
      if (!text) return;
      queue.push(text.endsWith('.') || text.endsWith('!') || text.endsWith('?') ? text : `${text}.`);
      wake?.();
    };

    const unsub = this.bus.subscribe((m: UIMessage) => {
      if (m.type === 'assistant' || m.type === 'say') {
        push(m.voiceText ?? m.text);
      } else if (m.type === 'ask') {
        // A blocking ask must be heard, options and all, or voice would silently stall.
        for (const q of m.questions) {
          push(q.question);
          push(`Options: ${q.options.map((o) => o.label).join(', ')}.`);
        }
      } else if (m.type === 'status' && (m.state === 'idle' || m.state === 'error')) {
        done = true;
        wake?.();
      }
    });

    this.session.send(utterance);

    return {
      async *[Symbol.asyncIterator]() {
        try {
          for (;;) {
            if (queue.length) {
              yield queue.shift()!;
              continue;
            }
            if (done) return;
            await new Promise<void>((r) => (wake = r));
          }
        } finally {
          unsub();
        }
      },
    };
  }

  /** Mint the short-lived browser token so the API key never reaches the page. */
  async mintToken(): Promise<{ token?: string; error?: string }> {
    if (!this.configured) return { error: this.unavailableReason ?? 'voice unavailable' };
    try {
      const res = await this.client.conversationalAi.conversations.getWebrtcToken({
        agentId: this.cfg.speechEngineId,
      });
      return { token: res.token };
    } catch (e) {
      return { error: String(e).slice(0, 300) };
    }
  }

  private endSession() {
    if (this.connectedAt === null) return;
    this.accruedUsd += this.sessionCost();
    this.connectedAt = null;
    this.publishVoice('disconnected');
  }

  /**
   * Cost of the CURRENT session so far. Connected time is billed; stretches of
   * silence longer than 10 s bill at 5%. Approximated from last-activity, which is
   * enough for a meter whose job is to prevent surprises.
   */
  private sessionCost(): number {
    if (this.connectedAt === null) return 0;
    const now = Date.now();
    const totalS = (now - this.connectedAt) / 1000;
    const idleS = (now - this.lastActivityAt) / 1000;
    const discounted = Math.max(0, idleS - SILENCE_DISCOUNT_AFTER_S);
    const billableS = totalS - discounted + discounted * SILENCE_RATE_MULTIPLIER;
    return (billableS / 60) * RATE_PER_MINUTE;
  }

  status() {
    return {
      available: this.configured && this.attached,
      reason: this.unavailableReason,
      connected: this.connectedAt !== null,
      connectedSeconds: this.connectedAt ? Math.round((Date.now() - this.connectedAt) / 1000) : 0,
      sessionUsd: Number(this.sessionCost().toFixed(4)),
      totalUsd: Number((this.accruedUsd + this.sessionCost()).toFixed(4)),
      ratePerMinute: RATE_PER_MINUTE,
    };
  }

  private publishVoice(state: string, detail?: string) {
    this.bus.publish({ type: 'voice', state, detail, status: this.status() } as UIMessage);
  }
}
