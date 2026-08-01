// Voice client — demand-scoped, because Speech Engine bills CONNECTED time.
//
// The mic stream is local and free; the ElevenLabs session is not. So the page
// listens on its own (Web Audio energy VAD), and only opens a paid session once
// Danny actually starts talking. Silence past the idle timeout closes it again.
// "Armed" therefore costs nothing; "connected" costs $0.08/min.
const IDLE_CLOSE_MS = 45_000;
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
        if (this.mode === 'connected') this.touch();
      } else {
        this.speechStart = 0;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** Open the paid session. Called by the VAD, or directly for an announcement. */
  async connect() {
    if (this.mode === 'connected' || this.connecting) return;
    this.connecting = true;
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

  /** Reset the idle countdown — any speech in either direction. */
  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.disconnect(), IDLE_CLOSE_MS);
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
