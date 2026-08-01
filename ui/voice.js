// Voice client — the mic button opens the channel; your voice does not.
//
// It used to: the page listened locally (free) and only opened the paid session
// once the VAD heard speech. That cost Danny the first four or five words of
// every utterance, because a token fetch plus a WebRTC handshake takes seconds
// and nothing was being captured during them. Worse, it made the problem
// unfixable by any indicator: the session only existed BECAUSE he had started
// talking, so "ready to talk" could not be known until after the words were
// already lost. The late red light was that same latency, seen a second time.
//
// So clicking the mic connects immediately, and readiness comes from the SDK's
// own onConnect rather than being inferred. Billing starts at the click instead
// of at first speech — worth roughly nothing, since ElevenLabs discounts silence
// past 10s by 95% (~$0.004/min), and it buys a light that means what it says.
//
// STATES: off (mic released) → connecting (opening, do NOT talk) → live (talk).
// Idle closes back to `armed`: mic still held, channel shut. That state is load
// bearing — an outbound announcement can reopen a session only from there, and
// speaking reopens it too (with the old clipping, which is now the rare path
// rather than every single utterance).
//
// Hold generously once open: a reconnect costs the opening of a sentence, and
// conversation activity counts as activity too (see touch() callers in app.js).
const IDLE_CLOSE_MS = 120_000;
// A session opened purely to SPEAK is not a conversation — it exists to deliver
// one line. Hold it briefly in case Danny answers (his voice promotes it to the
// full window), then let it close rather than billing for a channel nobody is in.
const ANNOUNCE_IDLE_CLOSE_MS = 30_000;
/**
 * How long a channel is held open WHILE SHE IS WORKING.
 *
 * The wait for a mouth is per SESSION, not per line: a channel that has already
 * carried a transcript can speak immediately, and a fresh one costs a handshake
 * plus 6-14 s of waiting for the recogniser to say something about an empty room
 * (see the note on speaking first, below). During a long job that closed-and-
 * reopened per announcement — paying the whole wait every time.
 *
 * So while a turn or a worker is in flight the window widens: pay the wait once
 * at the start of the job and let the rest of the lines land in a channel that is
 * already listening. Silence bills at 5% (~$0.004/min), so a ten-minute build
 * holds a channel for about two cents.
 */
const WORKING_IDLE_CLOSE_MS = 10 * 60_000;
const SPEECH_RMS = 0.02; // energy threshold that counts as "talking"
const SPEECH_MS = 200; // sustained for this long, to ignore keyboard clicks

export class VoiceClient {
  constructor(onState) {
    this.onState = onState;
    this.mode = 'off'; // off → connecting → connected; `armed` = mic held, channel shut
    this.conversation = null;
    this.audioCtx = null;
    this.micStream = null;
    this.idleTimer = null;
    this.speechStart = 0;
    // Which idle window applies to the CURRENT session — widened the moment
    // Danny actually speaks, so an announcement he replies to becomes a normal
    // conversation instead of hanging up on him.
    this.idleMs = IDLE_CLOSE_MS;
    /** True while a turn or a worker is running — see setWorking. */
    this.working = false;
  }

  get state() {
    return this.mode;
  }

  async arm() {
    if (this.mode !== 'off') return;
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.audioCtx = new AudioContext();
    const src = this.audioCtx.createMediaStreamSource(this.micStream);
    const analyser = this.audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    this.mode = 'armed';
    this.onState(this.mode);
    // Open the channel NOW rather than waiting to hear him. This is the whole
    // point: the indicator can only be honest if readiness precedes speech.
    void this.connect();

    const tick = () => {
      if (this.mode === 'off') return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);

      if (rms > SPEECH_RMS) {
        this.speechStart ||= performance.now();
        if (this.mode === 'armed' && performance.now() - this.speechStart > SPEECH_MS) {
          void this.connect();
        }
        if (this.mode === 'connected') {
          // He is talking: this is a conversation now, whatever opened it.
          this.idleMs = IDLE_CLOSE_MS;
          this.touch();
        }
      } else {
        this.speechStart = 0;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /**
   * Open the paid session. Called by the VAD, or directly for an announcement
   * (`reason: 'announce'`), which the harness requests when it has something to
   * say and the channel has closed underneath it.
   *
   * ⚠️ It needs the mic ARMED, and that is a product constraint rather than a
   * choice — see the note on `nudge` below. A muted session cannot be spoken
   * through at all.
   */
  async connect(reason = 'speech') {
    if (this.mode === 'connected' || this.connecting) return;
    this.connecting = true;
    this.idleMs = reason === 'announce' ? ANNOUNCE_IDLE_CLOSE_MS : IDLE_CLOSE_MS;
    // Announce this BEFORE the round trip, not after. These seconds are exactly
    // the ones Danny must not be talking through, so they need their own visible
    // state — reporting only the finished result is what made the red light look
    // late when it was really just telling him something he needed earlier.
    this.mode = 'connecting';
    this.onState(this.mode);
    const fallback = () => (this.mode = this.micStream ? 'armed' : 'off');
    try {
      const res = await fetch('/api/voice/token');
      const { token, error } = await res.json();
      if (error) {
        fallback();
        this.onState('error', error);
        return;
      }
      this.conversation = await window.ElevenLabsClient.Conversation.startSession({
        conversationToken: token,
        // The SDK's own readiness signal, rather than inferring it from the
        // awaited promise. This is the exact moment the channel is carrying
        // audio, which is the only honest moment to tell him to go ahead.
        onConnect: () => {
          this.mode = 'connected';
          this.onState(this.mode);
          this.touch();
        },
        onDisconnect: () => {
          fallback();
          this.onState(this.mode);
        },
      });
    } catch (e) {
      fallback();
      this.onState('error', String(e));
    } finally {
      this.connecting = false;
    }
  }

  /**
   * ⚠️ THERE IS NO WAY TO MAKE HER SPEAK FIRST. Both documented routes were
   * tried against the real service on 2026-08-01 and both failed:
   *
   *   - `sendUserMessage(text)` — the client really does put
   *     `{type:"user_message"}` on the data channel, but ElevenLabs never turns
   *     it into a `user_transcript` for a bring-your-own-LLM engine, so the
   *     harness gets nothing to answer.
   *   - `overrides.agent.firstMessage` — the mechanism their own SDK warning
   *     points at. A Speech Engine REJECTS the `conversation_initiation_client_data`
   *     override: "Server error: Unknown error", DataChannel errors on both lossy
   *     and reliable, and the room is torn down before it ever reaches us.
   *
   * So a session speaks only in reply to something it HEARD, which is why the
   * mic is what opens one. Do not re-derive this.
   */

  /**
   * Reset the idle countdown. Called by the local VAD when Danny speaks, and by
   * the page whenever the CONVERSATION moves — Beth answering, a turn starting.
   * Without the second kind, a long answer Danny listens to quietly counts as
   * idle, the session closes mid-exchange, and his reply pays for a reconnect.
   */
  touch() {
    if (this.mode !== 'connected') return;
    clearTimeout(this.idleTimer);
    // `working` outranks the announce window: a channel opened to deliver one
    // line becomes the channel the whole job speaks through.
    const ms = this.working ? Math.max(this.idleMs, WORKING_IDLE_CLOSE_MS) : this.idleMs;
    this.idleTimer = setTimeout(() => this.disconnect(), ms);
  }

  /**
   * Whether something is running for her — a turn, or a background worker. Set
   * from the page's own busy state, which is what the composer spinner shows.
   */
  setWorking(working) {
    if (this.working === working) return;
    this.working = working;
    // Re-arm on both edges: widen the window when work starts, and start the
    // ordinary countdown the moment it stops rather than a job later.
    this.touch();
  }

  async disconnect() {
    clearTimeout(this.idleTimer);
    if (this.conversation) {
      await this.conversation.endSession().catch(() => {});
      this.conversation = null;
    }
    if (this.mode === 'connected') {
      this.mode = this.micStream ? 'armed' : 'off';
      this.onState(this.mode);
    }
  }

  async off() {
    await this.disconnect();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    await this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.mode = 'off';
    this.onState(this.mode);
  }
}
