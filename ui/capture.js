// The microphone we OWN — the capture half of the Scribe ear.
//
// The Web Speech API opens its own mic and takes no constraints, which is why
// echo cancellation never reached it (docs/voice-plane.md). This stream is
// ours: AEC and noise suppression are requested explicitly, the worklet in
// pcm-worklet.js turns it into 16k int16 parcels, and each parcel is handed to
// `postAudio` — in the harness, a POST to /api/ear/audio on loopback.
//
// Parking DROPS parcels rather than pausing the context: the mic stays warm
// (no re-permission, no spin-up gap), nothing reaches the server, and since
// billing is metered where audio is forwarded to Scribe, a parked ear costs
// exactly nothing. The RMS barge-in meter is the same fifteen lines listen.js
// carries, on the same echo-cancelled stream.

/** Sustained mic energy that counts as an interruption while she is speaking. */
const BARGE_RMS = 0.045;
const BARGE_MS = 250;

export class Capture {
  /**
   * @param opts.postAudio  (Int16Array) — a parcel of 16k mono PCM
   * @param opts.isSpeaking () — is SHE talking right now
   * @param opts.stopSpeaking () — cut her off, for barge-in
   * @param opts.getMedia / opts.makeContext — injected in tests
   */
  constructor(opts) {
    this.opts = opts;
    this.stream = null;
    this.ctx = null;
    this.node = null;
    this.on = false;
    this.parked = false;
    this.meterTimer = null;
    this.overSince = 0;
  }

  async arm() {
    if (this.on) return;
    const getMedia =
      this.opts.getMedia ?? ((c) => navigator.mediaDevices.getUserMedia(c));
    // OUR capture, cleaned. This is the asymmetry the whole migration buys:
    // the recogniser finally hears the echo-cancelled stream.
    this.stream = await getMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.on = true;
    this.parked = false;
    const makeContext = this.opts.makeContext ?? (() => new AudioContext());
    this.ctx = makeContext();
    await this.ctx.audioWorklet.addModule('/pcm-worklet.js');
    this.node = new AudioWorkletNode(this.ctx, 'pcm-tap');
    this.node.port.onmessage = (e) => {
      // Every drop reason in one place: not armed (a straggler parcel after
      // off), or parked (she is talking; forwarding would bill her own voice).
      if (!this.on || this.parked) return;
      this.opts.postAudio(e.data);
    };
    this.ctx.createMediaStreamSource(this.stream).connect(this.node);
    this.startMeter();
  }

  async off() {
    this.on = false;
    this.parked = false;
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = null;
    try {
      this.node?.port.postMessage('stop');
    } catch {}
    this.node = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    try {
      await this.ctx?.close();
    } catch {}
    this.ctx = null;
  }

  park() {
    if (this.on) this.parked = true;
  }

  unpark() {
    this.parked = false;
  }

  /** Same gate as listen.js, on the stream AEC actually cleans. */
  startMeter() {
    if (!this.ctx?.createAnalyser) return;
    const node = this.ctx.createAnalyser();
    node.fftSize = 1024;
    this.ctx.createMediaStreamSource(this.stream).connect(node);
    const buf = new Float32Array(node.fftSize);
    this.meterTimer = setInterval(() => {
      if (!this.opts.isSpeaking?.()) {
        this.overSince = 0;
        return;
      }
      node.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const s of buf) sum += s * s;
      if (Math.sqrt(sum / buf.length) <= BARGE_RMS) {
        this.overSince = 0;
        return;
      }
      this.overSince ||= performance.now();
      if (performance.now() - this.overSince < BARGE_MS) return;
      this.overSince = 0;
      this.opts.stopSpeaking?.();
    }, 50);
  }
}
