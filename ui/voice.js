// Voice client — demand-scoped, because Speech Engine bills CONNECTED time.
//
// The mic stream is local and free; the ElevenLabs session is not. So the page
// listens on its own (Web Audio energy VAD), and only opens a paid session once
// Danny actually starts talking. Silence past the idle timeout closes it again.
// "Armed" therefore costs nothing; "connected" costs $0.08/min.
// Holding the session open through a conversation is nearly free and reconnecting
// is expensive in the only currency that matters here — the first second of what
// Danny says. ElevenLabs discounts silence past 10s by 95%, so an idle minute is
// about $0.004; a reconnect costs a WebRTC handshake during which his opening
// words are simply not being captured. So: hold generously, and treat anything
// happening in the conversation as activity (see touch() callers in app.js).
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
    this.mode = 'off'; // off → armed (free, listening locally) → connected (paid)
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
    try {
      const res = await fetch('/api/voice/token');
      const { token, error } = await res.json();
      if (error) {
        this.onState('error', error);
        return;
      }
      this.conversation = await window.ElevenLabsClient.Conversation.startSession({
        conversationToken: token,
        onDisconnect: () => {
          this.mode = this.micStream ? 'armed' : 'off';
          this.onState(this.mode);
        },
      });
      this.mode = 'connected';
      this.onState(this.mode);
      this.touch();
    } catch (e) {
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
