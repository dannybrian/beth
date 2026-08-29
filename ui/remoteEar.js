// The Scribe ear, wearing the Listener's face.
//
// app.js picks this or listen.js by what `hello` says and touches nothing else
// — same constructor shape, same arm/off/abandon/park/unpark, same state
// values. Recognition itself lives server-side (src/earHost.ts holds the
// Scribe session; the key never reaches this page); what this class owns is
// the CAPTURE (capture.js) and the translation of `ear` SSE messages back
// into the callbacks the composer already speaks.
//
// The rules it inherits are behavioural, not incidental, and each is tested:
//   - off() NEVER emits onSettled — reaching for the mic is a way OUT of a
//     sentence, not a commit of it.
//   - abandon() tells the SERVER before anything else: the utterance lives in
//     the Scribe session now, and clearing the composer first would let the
//     next frame render it straight back (the same order bug listen.js fought).
//   - a commit that arrives while parked belongs to the other side of her
//     sentence and is dropped, exactly like the settle timer was.
// Relative on purpose: the browser resolves it to the same /capture.js, and
// node can resolve it at all — which is what lets remoteEar.test.ts exist.
import { Capture } from './capture.js';

export class RemoteEar {
  /**
   * @param opts.streamId  () — this tab's SSE stream id (ownership + steal)
   * @param opts.onState / onInterim / onSettled / isSpeaking / stopSpeaking —
   *        the Listener contract, unchanged
   * @param opts.onDegraded (detail) — the engine gave up; the caller decides
   *        what "listen another way" means (app.js swaps in the browser ear)
   * @param opts.post — injected in tests; defaults to a JSON POST
   */
  constructor(opts) {
    this.opts = opts;
    this.mode = 'off';
    this.post =
      opts.post ??
      ((path, body) =>
        fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }));
    this.capture =
      opts.capture ??
      new Capture({
        postAudio: (pcm) =>
          fetch(`/api/ear/audio?stream=${this.opts.streamId()}`, { method: 'POST', body: pcm.buffer }),
        isSpeaking: opts.isSpeaking,
        stopSpeaking: opts.stopSpeaking,
      });
  }

  get state() {
    return this.mode;
  }

  /** Kept for the old call sites, like listen.js keeps them. */
  touch() {}
  setWorking() {}
  async connect() {}

  async arm() {
    if (this.mode !== 'off') return;
    // Mic permission FIRST: if the browser refuses, nothing was armed
    // server-side and there is nothing to unwind.
    await this.capture.arm();
    const res = await this.post('/api/ear', { on: true, streamId: this.opts.streamId() });
    const body = res && typeof res.json === 'function' ? await res.json().catch(() => ({})) : (res ?? {});
    if (body.ok === false) {
      await this.capture.off();
      this.mode = 'error';
      this.opts.onState?.('error', body.reason ?? 'ear refused');
      return;
    }
    this.mode = 'listening';
    this.opts.onState?.('listening');
  }

  /** ⚠️ Turning the ear off NEVER sends what it was holding. See listen.js. */
  async off() {
    if (this.mode === 'off') return;
    this.mode = 'off';
    await this.capture.off();
    this.post('/api/ear', { on: false, streamId: this.opts.streamId() });
    this.opts.onState?.('off');
  }

  /**
   * Drop the utterance in flight without closing the ear. Server first — the
   * words live in the Scribe session, and until it agrees to swallow them the
   * next partial would put them right back in the composer.
   */
  abandon() {
    if (this.mode !== 'listening') return;
    this.post('/api/ear/abandon', { streamId: this.opts.streamId() });
  }

  park() {
    this.capture.park();
  }

  unpark() {
    this.capture.unpark();
  }

  /** `ear` messages off the SSE stream, routed here by app.js's handler map. */
  onEar(m) {
    if (m.owner !== this.opts.streamId()) return;
    switch (m.state) {
      case 'partial':
        if (this.mode !== 'listening' || this.capture.parked) return;
        // Heard while she is talking: with the ear parked this should not
        // happen; if it does it is her voice, and rendering it begins the loop
        // where she talks to herself.
        if (this.opts.isSpeaking?.()) return;
        this.opts.onInterim?.(m.text ?? '');
        return;
      case 'commit':
        if (this.mode !== 'listening' || this.capture.parked) return;
        if (this.opts.isSpeaking?.()) return;
        if (m.text?.trim()) this.opts.onSettled?.(m.text);
        return;
      case 'off':
        // The session ended without us asking — another tab took the mic.
        if (this.mode === 'listening') {
          this.mode = 'off';
          void this.capture.off();
          this.opts.onState?.('off', m.detail);
        }
        return;
      case 'degraded':
        if (this.mode === 'off') return;
        this.mode = 'error';
        void this.capture.off();
        this.opts.onState?.('error', m.detail);
        this.opts.onDegraded?.(m.detail);
        return;
    }
  }
}
