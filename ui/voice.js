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
   * Reset the idle countdown. Called by the local VAD when Danny speaks, and by
   * the page whenever the CONVERSATION moves — Beth answering, a turn starting.
   * Without the second kind, a long answer Danny listens to quietly counts as
   * idle, the session closes mid-exchange, and his reply pays for a reconnect.
   */
  touch() {
    if (this.mode !== 'connected') return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.disconnect(), this.idleMs);
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
