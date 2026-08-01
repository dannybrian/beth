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
/**
 * How long an unspoken announcement stays worth saying. News goes stale: if the
 * paid session cannot be opened (voice off, browser closed), replaying "that's
 * shipped" ten minutes later is worse than silence.
 */
const ANNOUNCE_MAX_AGE_MS = 90_000;
/** Backstop so a long unattended run cannot queue a monologue. */
const ANNOUNCE_MAX_QUEUED = 6;

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
  /** Lines produced while no paid session existed, waiting for one to open. */
  private pendingAnnouncements: { text: string; at: number }[] = [];
  private lastActivityAt = 0;
  private accruedUsd = 0;
  /** Serialises spoken lines — see the bus subscriber below. */
  private speakQueue: Promise<unknown> = Promise.resolve();

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
      if (this.turnActive) return;
      const text = forVoice(m.voiceText ?? m.text, this.cfg.audioTagsSupported && this.tagsSupported).trim();
      if (!text) return;
      // No paid session right now — the usual case being that the work took
      // longer than the client's idle window, so the channel closed mid-job.
      // Dropping the line here is what made long operations end in silence:
      // the more valuable the result, the more certain it was inaudible.
      if (!this.liveSession) {
        this.queueAnnouncement(text);
        return;
      }
      this.lastActivityAt = Date.now();
      // Serialised: each sendResponse ends by sending the is_final marker, so two
      // overlapping ones truncate each other — the second line would cut the first
      // short. Chain them instead of firing concurrently.
      this.speakQueue = this.speakQueue
        .then(() => this.liveSession?.sendResponse(text))
        .catch(() => {
          /* session may have closed underneath us */
        });
    });
  }

  /**
   * Hold a line that has nobody to say it to, and ask the page to open a session.
   *
   * The browser owns the WebRTC leg, so the server cannot dial out — it can only
   * raise a hand. `speak-request` is that hand: the page opens a short session if
   * (and only if) the mic is armed, and `onInit` flushes whatever is waiting.
   * When voice is off entirely, nothing opens and the queue simply ages out —
   * silence is what "voice off" means.
   */
  private queueAnnouncement(text: string) {
    this.pendingAnnouncements.push({ text, at: Date.now() });
    // Keep the newest: if we are over the cap, the oldest news is the most stale.
    if (this.pendingAnnouncements.length > ANNOUNCE_MAX_QUEUED) {
      this.pendingAnnouncements.splice(0, this.pendingAnnouncements.length - ANNOUNCE_MAX_QUEUED);
    }
    this.publishVoice('speak-request', text.slice(0, 80));
  }

  /**
   * Forget the session and settle the books. Idempotent, because the two
   * callbacks that reach it can both fire for one ending.
   */
  private teardownSession() {
    this.liveSession = null;
    // A pending turn belongs to a session that no longer exists.
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.lastSettled = '';
    this.turnActive = false;
    this.endSession();
  }

  /** Speak whatever is still worth speaking, oldest first. */
  private flushAnnouncements() {
    if (!this.liveSession || this.pendingAnnouncements.length === 0) return;
    const now = Date.now();
    const fresh = this.pendingAnnouncements.filter((a) => now - a.at <= ANNOUNCE_MAX_AGE_MS);
    const dropped = this.pendingAnnouncements.length - fresh.length;
    this.pendingAnnouncements = [];
    if (dropped > 0) console.log(`  voice: dropped ${dropped} stale announcement(s)`);
    if (fresh.length === 0) return;
    this.lastActivityAt = now;
    for (const a of fresh) {
      this.speakQueue = this.speakQueue
        .then(() => this.liveSession?.sendResponse(a.text))
        .catch(() => {
          /* session may have closed underneath us */
        });
    }
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
      // ⚠️ The session arrives HERE too, not only on a transcript. Capturing it
      // only in onTranscript meant a session opened without anyone speaking had
      // nothing to speak THROUGH — which is precisely the announcement case.
      onInit: (conversationId: string, session: any) => {
        this.liveSession = session;
        this.connectedAt = Date.now();
        this.lastActivityAt = Date.now();
        // Spoken conversation wants answers in seconds; the director turn, not TTS,
        // is what makes voice feel slow. Drop effort for the life of the voice
        // session and restore it when the session closes, so typed work keeps full
        // reasoning. Runtime effort mutation was proven in the Phase 0 spike.
        if (this.cfg.voiceEffort) {
          void this.session.setEffort(this.cfg.voiceEffort).catch(() => {});
          console.log(`  voice: effort → ${this.cfg.voiceEffort} for this session`);
        }
        this.publishVoice('connected', `voice session ${String(conversationId).slice(0, 12)}…`);
        // Anything that piled up while the channel was shut now has a mouth.
        this.flushAnnouncements();
      },
      onTranscript: (transcript: Transcript, signal: AbortSignal, session: any) => {
        this.lastActivityAt = Date.now();
        // ⚠️ Do NOT call Query.interrupt() here. Speech Engine aborts the in-flight
        // response for ordinary transcript REVISIONS, not only for genuine barge-in.
        // Interrupting the director on every revision killed its turn mid-flight,
        // produced an error result, returned zero chunks, and made ElevenLabs
        // re-deliver the transcript — an endless ping-pong.
        //
        // ⚠️ And do not clear `turnActive` here either, which is what this used to
        // do. `turnActive` is what stops the bus subscriber in the constructor from
        // ALSO speaking the same lines: clearing it mid-response opened a second,
        // concurrent sendResponse on the same session. Both streams then raced, and
        // whichever finished first sent the is_final marker — so the rest of a long
        // answer was silently discarded and Beth simply never read it out.
        // Only the response's own completion may clear it.
        void signal;
        this.liveSession = session;
        const utterance = [...transcript].reverse().find((m) => m.role === 'user')?.content ?? '';
        // Silence transcribes as "..." — never spend a Claude turn on it.
        if (!isMeaningfulUtterance(utterance)) {
          this.bus.publish({ type: 'voice', state: 'ignored', detail: utterance.trim(), status: this.status() });
          return;
        }
        this.scheduleTurn(utterance, session);
      },
      // ⚠️ TWO callbacks, not one. `close` fires only for an explicit protocol
      // close message; a websocket that simply DROPS — which is what the
      // browser ending the session produces — emits `disconnected` instead.
      // Wiring only `close` left `liveSession` pointing at a dead session, so
      // `!this.liveSession` stayed false, nothing queued, and sendResponse threw
      // into a catch: announcements silently dropped again, by the very path
      // that closes most often. It also stranded the cost meter and left voice
      // effort pinned low for typed work.
      onClose: () => this.teardownSession(),
      onDisconnect: () => this.teardownSession(),
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
   * Start ONE director turn once Danny has stopped talking.
   *
   * ElevenLabs delivers a growing utterance as several transcripts while he is
   * still speaking — "…on this plan." then "…on this plan, but let's review."
   * then "…but let's review, uh, if anything was missed." The SDK's model is to
   * abort the in-flight LLM call and start a new one per transcript, which is
   * right for a stateless completion and WRONG here: every session.send() appends
   * a user turn to a long-lived conversation that cannot be un-sent. Acting on
   * each revision turned one sentence into five director turns, each doing its
   * own tool calls, talking over each other.
   *
   * So revisions only reset a timer; the turn fires when the transcript has been
   * still for `voiceSettleMs`. Deferring is safe because the SDK keeps
   * `inTranscriptHandler` true until the session closes, and captures the CURRENT
   * event id when the response starts — so a late response lands against the
   * newest transcript, which is exactly the one we want to answer.
   */
  private settleTimer: NodeJS.Timeout | null = null;
  private pendingUtterance = '';
  /** The full utterance last acted on — what a continuation is measured against. */
  private lastSettled = '';
  /** Serialises spoken TURNS. See the is_final note in scheduleTurn. */
  private turnChain: Promise<unknown> = Promise.resolve();

  private scheduleTurn(utterance: string, session: any) {
    this.pendingUtterance = utterance;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    // Surfaced so an early or late turn is diagnosable without guessing.
    this.bus.publish({ type: 'voice', state: 'hearing', detail: utterance, status: this.status() });

    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      const full = this.pendingUtterance;

      // ElevenLabs re-delivers a transcript it thinks went unanswered. Answering
      // it again would repeat Beth's reply and burn a second turn on a question
      // already asked, so an identical settled utterance is dropped.
      if (full === this.lastSettled) {
        this.bus.publish({ type: 'voice', state: 'duplicate', detail: full, status: this.status() });
        return;
      }

      // A CONTINUATION of what we just answered — proof the window closed while
      // Danny was mid-sentence. Transcripts accumulate, so the new one contains
      // the old as a prefix; re-sending the whole thing asks the same question
      // twice and gets it answered twice. Send only the words he has added, which
      // the session reads as the continuation it is.
      let toSend = full;
      if (this.lastSettled && full.startsWith(this.lastSettled)) {
        toSend = full.slice(this.lastSettled.length).trim();
        if (!toSend) {
          this.bus.publish({ type: 'voice', state: 'duplicate', detail: full, status: this.status() });
          return;
        }
        this.bus.publish({ type: 'voice', state: 'continuation', detail: toSend, status: this.status() });
      }
      this.lastSettled = full;

      // ⚠️ NEVER two spoken responses at once. Each sendResponse ends by sending
      // the is_final marker, so a second one racing the first makes whichever
      // finishes sooner close the agent turn — and the rest of the other answer
      // is discarded unheard. That is how "Let me check the evidence on disk."
      // became the last thing Danny heard: a turn fired early, its continuation
      // fired a second one, and they cut each other off. Chain them instead.
      this.turnActive = true;
      this.turnChain = this.turnChain
        .then(() => session.sendResponse(this.runTurn(toSend)))
        .catch(() => {
          /* session may have closed underneath us */
        })
        .finally(() => {
          this.turnActive = false;
        });
    }, this.cfg.voiceSettleMs);
    this.settleTimer.unref?.();
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
    let myTurn = -1;

    const filler = this.pickFiller();
    const fillerDelayMs = this.cfg.fillerDelayMs;

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
        // Only MY turn finishing ends this stream. Without the correlation, a
        // previous turn's `idle` terminated a freshly-started voice turn instantly.
        if (m.turn === undefined || m.turn >= myTurn) {
          done = true;
          wake?.();
        }
      }
    });

    // sendPointed, not send: a plan clicked in the panel has to reach a SPOKEN
    // turn too. Pointing lives on the server precisely because this path never
    // touches the browser — ElevenLabs dials in and the utterance comes here.
    myTurn = this.session.sendPointed(utterance);

    /** Resolves false when woken by new text, true when the wait timed out. */
    const waitForText = (ms?: number) =>
      new Promise<boolean>((resolve) => {
        let settled = false;
        wake = () => {
          if (settled) return;
          settled = true;
          resolve(false);
        };
        if (ms !== undefined) {
          setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(true);
          }, ms).unref?.();
        }
      });

    return {
      async *[Symbol.asyncIterator]() {
        let emitted = 0;
        try {
          for (;;) {
            if (queue.length) {
              emitted++;
              yield queue.shift()!;
              continue;
            }
            if (done) break;

            // The filler is a LATENESS signal, not a greeting. Wait first: if the
            // real answer arrives inside the window, Danny never hears "let me
            // check" in front of a fast reply. Only a genuinely slow turn gets one.
            if (emitted === 0) {
              const timedOut = await waitForText(fillerDelayMs);
              if (timedOut && !queue.length && !done) {
                emitted++;
                yield filler;
              }
              continue;
            }
            await waitForText();
          }
          // Never end an empty response: ElevenLabs re-delivers the transcript when
          // it gets nothing back, which is how the ping-pong loop started.
          if (emitted === 0) yield 'Sorry — I came up empty on that one.';
        } finally {
          unsub();
        }
      },
    };
  }

  /**
   * A short acknowledgement spoken while the director thinks. Varied so it does
   * not become a tic, and deliberately plain — it is a turn-taking signal, not a
   * personality. Index-based rather than random so a run is reproducible.
   */
  private fillerIndex = 0;
  private pickFiller(): string {
    const fillers = ['Let me check.', 'One moment.', 'Looking now.', 'Give me a second.', 'Checking.'];
    return fillers[this.fillerIndex++ % fillers.length];
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
    // Restore full reasoning for typed work.
    if (this.cfg.voiceEffort) void this.session.setEffort(null).catch(() => {});
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
