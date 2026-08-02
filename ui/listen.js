// The ear, in the browser. The other half of leaving Speech Engine.
//
// Everything here was proved in spike/voice-plane before it was written down —
// the echo behaviour, the settle rule, and the barge-in threshold are measured
// numbers, not guesses. See docs/voice-plane.md.
//
// What this replaces is not a recogniser but a TRANSPORT: ElevenLabs dialled in
// over a tunnel to a public port, billed by the minute, and could only speak in
// reply to something it heard. Recognition happens here now, the text goes out
// as an ordinary turn, and her voice comes back as audio the page plays. Nothing
// dials in, nothing is billed while idle, and she can talk whenever she likes.

/**
 * How long the words must stop CHANGING before a turn is sent, while Chrome is
 * still revising its guess. Overridden from the server's HARNESS_VOICE_SETTLE_MS
 * so one knob still tunes both planes.
 */
const SETTLE_MS = 2500;
/**
 * The shorter window once Chrome marks a segment `isFinal`.
 *
 * That flag is a stronger end-of-utterance signal than anything ElevenLabs ever
 * sent — Chrome only sets it after a real pause — so a settled segment does not
 * need the full window stacked on top of the pause that produced it. Waiting the
 * full 2.5s there is most of what reads as the page chewing on a finished
 * sentence before sending it.
 */
const FINAL_SETTLE_MS = 1200;
/** Sustained mic energy that counts as an interruption while she is speaking. */
const BARGE_RMS = 0.045;
const BARGE_MS = 250;
/** The tail of her audio is still in the room; reopening into it hears her. */
const REOPEN_DELAY_MS = 300;

/**
 * Spoken punctuation. Chrome returns a flat run of words and has no dictation
 * mode, so "period" arrives as the word.
 *
 * ⚠️ It will eat a real "the settle period". That is the cost of a substitution
 * trick, and it is why this is switchable — the durable fix is a recogniser that
 * punctuates (Scribe), not a longer table.
 */
const DICTATION = [
  [/\b(?:full stop|period)\b/gi, '.'],
  [/\bcomma\b/gi, ','],
  [/\bquestion mark\b/gi, '?'],
  [/\bexclamation (?:mark|point)\b/gi, '!'],
  [/\bsemicolon\b/gi, ';'],
  [/\bcolon\b/gi, ':'],
  [/\b(?:dash|em dash)\b/gi, '—'],
  [/\bopen (?:paren|parenthesis|bracket)\b/gi, '('],
  [/\bclose (?:paren|parenthesis|bracket)\b/gi, ')'],
  [/\bnew paragraph\b/gi, '\n\n'],
  [/\bnew line\b/gi, '\n'],
];

export function punctuate(text) {
  let out = text;
  for (const [re, ch] of DICTATION) out = out.replace(re, ch);
  return out
    .replace(/[ \t]+([.,;:!?)])/g, '$1')
    .replace(/([(])[ \t]+/g, '$1')
    .replace(/([.!?])[ \t]*(\S)/g, '$1 $2')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/(^|[.!?] |\n)([a-z])/g, (_, pre, c) => pre + c.toUpperCase())
    .trim();
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const listenSupported = Boolean(SR);

export class Listener {
  /**
   * @param opts.onState    (state, detail) — off | listening | error
   * @param opts.onInterim  (text) — what is being heard, punctuated as it will be sent
   * @param opts.onSettled  (text) — the turn, once the words stopped changing
   * @param opts.isSpeaking () — is SHE talking right now
   * @param opts.stopSpeaking () — cut her off, for barge-in
   */
  constructor(opts) {
    this.opts = opts;
    this.mode = 'off';
    this.rec = null;
    this.parked = false;
    this.consumedUpTo = 0;
    this.settleTimer = null;
    this.timerWait = 0;
    this.lastHeard = '';
    this.pending = '';
    /**
     * Words from RECOGNISERS THAT HAVE ALREADY ENDED, still part of this
     * utterance.
     *
     * Chrome ends a session on its own schedule — a long sentence outlives one —
     * and each new recogniser starts with empty `results`. Without this, the next
     * result rendered only the words said AFTER the restart, so talking for more
     * than about twenty seconds made the composer reset and refill with the tail
     * of your own sentence.
     */
    this.carry = '';
    /** Which recogniser and how far into it the pending text reaches. */
    this.consumeFrom = null;
    this.micStream = null;
    this.meterTimer = null;
    this.overSince = 0;
    this.settleMs = opts.settleMs || SETTLE_MS;
    this.dictation = true;
    /**
     * Project nouns to bias toward, and how hard. See src/keyterms.ts — a
     * conversation about a project is made mostly of words a general recogniser
     * has never heard, and it does not fail loudly: it substitutes the nearest
     * real word, so "colyseus" comes back "colossus" and the sentence still
     * parses.
     */
    this.phrases = opts.phrases ?? [];
    this.boost = opts.boost ?? 2;
    /** Latched when Chrome refuses a biased recogniser. See applyBiasing. */
    this.biasingRefused = false;
    /**
     * Chrome ties phrase biasing to its ON-DEVICE model, which may not be
     * installed. Probed once, never awaited: `available()` is allowed to take as
     * long as it likes, and arming the mic must not wait for it — a slow probe
     * would show up as a mic that takes a second to turn on.
     *
     * ⚠️ Nothing here calls `install()`. That downloads a model onto his machine,
     * which is not a thing a page should decide to do while he is talking.
     */
    this.onDevice = false;
    this.probeOnDevice();
  }

  probeOnDevice() {
    if (!this.phrases.length || typeof SR?.available !== 'function') return;
    try {
      Promise.resolve(SR.available({ langs: ['en-US'], processLocally: true }))
        .then((status) => {
          this.onDevice = status === 'available';
          if (!this.onDevice) this.opts.onState?.(this.mode, `on-device model ${status} — biasing may be ignored`);
        })
        .catch(() => {});
    } catch {
      /* an API that is not there is the ordinary case, not an error */
    }
  }

  /**
   * Hand the recogniser the vocabulary, if this browser has the hook.
   *
   * ⚠️ Per RECOGNISER, not once. Chrome ends a session on its own schedule and
   * `startRec` builds a fresh instance every time — biasing set only on the first
   * one would quietly stop applying about twenty seconds into the first long
   * sentence, which is the same seam the `carry` fix exists for and would be just
   * as invisible.
   */
  applyBiasing(r) {
    if (this.biasingRefused || !this.phrases.length) return false;
    if (!('phrases' in r) || typeof window.SpeechRecognitionPhrase !== 'function') return false;
    try {
      r.phrases = this.phrases.map((p) => new window.SpeechRecognitionPhrase(p, this.boost));
      // Only when the model is actually there: forcing local processing without
      // it is how you get a recogniser that refuses to start at all.
      if (this.onDevice) r.processLocally = true;
      return true;
    } catch {
      // A browser that has the property but rejects the value is one we bias
      // nothing on. The ear matters more than the vocabulary.
      this.biasingRefused = true;
      return false;
    }
  }

  get state() {
    return this.mode;
  }

  /** Nothing to keep alive — there is no paid channel. Kept for the old call sites. */
  touch() {}
  setWorking() {}
  /** She can already speak; there is no session to open on her behalf. */
  async connect() {}

  async arm() {
    if (this.mode !== 'off') return;
    if (!SR) throw new Error('This browser has no speech recognition — Chrome does.');
    // OUR capture, with echo cancellation asked for explicitly. The recogniser
    // opens its own microphone and accepts no constraints, so this stream is the
    // only one we can clean — and it is the one the barge-in gate runs on. That
    // asymmetry is why parking the ear below is load-bearing rather than an
    // optimisation.
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.mode = 'listening';
    this.opts.onState?.('listening');
    this.startRec();
    this.startMeter();
  }

  /**
   * Throw away the utterance in flight, WITHOUT closing the ear.
   *
   * Recognition is wrong often enough that "don't send that" has to be a control
   * of its own. The settle window is 1.2–2.5s wide, which is time to see bad
   * words appear and hit Stop, but only if hitting Stop actually reaches the
   * words — cancelling the timer alone is not enough, because the recogniser
   * still holds them and its next result would render them straight back into
   * the composer.
   */
  abandon() {
    clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.timerWait = 0;
    this.lastHeard = '';
    this.pending = '';
    this.carry = '';
    // Spend what the CURRENT recogniser has delivered. Same test as the settle
    // callback: if Chrome swapped it while the window was open, its results are
    // new speech and abandoning the old utterance must not swallow them.
    if (this.consumeFrom?.rec === this.rec) this.consumedUpTo = this.consumeFrom.count;
    this.consumeFrom = null;
  }

  /**
   * ⚠️ Turning the ear off NEVER sends what it was holding.
   *
   * Reaching for the mic is what Danny does when the transcription is going
   * wrong, so switching it off has to be a way OUT of the sentence, not a commit
   * of it. The words stay in the composer to be fixed or thrown away by hand;
   * nothing about closing the ear puts them on the wire.
   */
  async off() {
    this.mode = 'off';
    this.parked = false;
    this.stopRec();
    this.abandon();
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = null;
    for (const t of this.micStream?.getTracks() ?? []) t.stop();
    this.micStream = null;
    this.opts.onState?.('off');
  }

  /**
   * EXACTLY ONE recogniser at a time.
   *
   * Chrome ends a session on its own schedule and on every `no-speech`, so the
   * restart loop is unavoidable — but a superseded instance keeps firing at the
   * old handlers, and two live recognisers each run their own settle window. That
   * turned one utterance into two turns, talking over each other, which is the
   * same shape of bug the Speech Engine settle window existed to prevent.
   */
  startRec() {
    if (this.rec) return;
    const r = new SR();
    this.rec = r;
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-US';
    this.consumedUpTo = 0;
    const biased = this.applyBiasing(r);
    r.onresult = (e) => this.rec === r && this.onResult(e);
    r.onerror = (e) => {
      // `no-speech` is ordinary — it is what a session timing out in silence says.
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      // A refusal that names the vocabulary costs us the vocabulary, not the ear.
      if (biased && /phrase|language|local/i.test(e.error ?? '')) return this.dropBiasing(r, e.error);
      this.opts.onState?.(this.mode === 'off' ? 'off' : 'error', e.error);
    };
    r.onend = () => {
      if (this.rec !== r) return;
      this.rec = null;
      if (this.mode !== 'listening' || this.parked) return;
      // Carry the utterance across the seam. The words are only in the ending
      // session's `results`, which the next recogniser does not inherit.
      this.carry = this.pending;
      this.startRec();
    };
    try {
      r.start();
    } catch (e) {
      this.rec = null;
      // Same trade as the error handler: if the biased recogniser will not start,
      // start an unbiased one. Mangled project nouns are a nuisance; a mic that
      // does nothing is the feature gone.
      if (biased) return this.dropBiasing(r, String(e));
      this.opts.onState?.('error', String(e));
    }
  }

  /**
   * Give up the vocabulary and try again, once, plainly.
   *
   * Biasing is an enhancement on a path that already worked. Anything that makes
   * it the reason the ear is dead has the priority backwards — so the refusal is
   * latched (no loop), reported once so it is not a silent downgrade, and the
   * recogniser is rebuilt without it.
   */
  dropBiasing(r, why) {
    if (this.biasingRefused) return;
    this.biasingRefused = true;
    if (this.rec === r) this.rec = null;
    this.opts.onState?.(this.mode === 'off' ? 'off' : 'listening', `keyterm biasing refused (${why}) — listening without it`);
    if (this.mode === 'listening' && !this.parked) this.startRec();
  }

  stopRec() {
    const r = this.rec;
    if (!r) return;
    this.rec = null;
    r.onresult = r.onerror = r.onend = null;
    try {
      r.stop();
    } catch {
      /* already ending */
    }
  }

  onResult(e) {
    const rec = this.rec;
    let text = '';
    let allFinal = true;
    for (let i = this.consumedUpTo; i < e.results.length; i++) {
      text += e.results[i][0].transcript;
      if (!e.results[i].isFinal) allFinal = false;
    }
    // What THIS session heard, on top of whatever earlier ones did before Chrome
    // ended them. One utterance, however many recognisers it took.
    const full = `${this.carry} ${text.trim()}`.trim();
    // Remember where to resume from, against the recogniser it belongs to: by the
    // time the window settles, Chrome may have handed us a different one.
    this.consumeFrom = { rec, count: e.results.length };
    const shown = full && this.dictation ? punctuate(full) : full;
    this.opts.onInterim?.(shown);
    if (!full) return;

    // Heard while she is talking. With the ear parked this should not happen at
    // all; if it does, it is her voice through the speakers, and answering it
    // would be the loop where she talks to herself.
    if (this.opts.isSpeaking?.()) return;

    // ⚠️ The window waits for the words to stop CHANGING, not for the EVENTS to
    // stop arriving. Chrome fires onresult continuously while it revises its own
    // guess, so restarting the timer on every event let a fiddling recogniser
    // hold a finished sentence indefinitely — which reads as the page chewing on
    // your words before it sends them. Compare the strings.
    const wait = allFinal ? Math.min(FINAL_SETTLE_MS, this.settleMs) : this.settleMs;
    const changed = full !== this.lastHeard;
    this.lastHeard = full;
    this.pending = full;
    // Restart only when the words moved, or when going final SHORTENS the wait.
    if (!changed && wait >= this.timerWait && this.settleTimer) return;
    clearTimeout(this.settleTimer);
    this.timerWait = wait;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.timerWait = 0;
      this.lastHeard = '';
      this.carry = '';
      // Consume only what the CURRENT recogniser has delivered. If Chrome swapped
      // it while the window was open, its results are new speech and none of it
      // has been sent.
      this.consumedUpTo = this.consumeFrom?.rec === this.rec ? this.consumeFrom.count : 0;
      this.consumeFrom = null;
      const raw = this.pending.trim();
      this.pending = '';
      if (!raw) return;
      this.opts.onSettled?.(this.dictation ? punctuate(raw) : raw);
    }, wait);
  }

  /**
   * Half duplex: the ear closes while she talks and reopens after a guard.
   *
   * This is what stops her hearing herself, and it is not optional — echo
   * cancellation cannot reach the recogniser's own capture (see arm()). What it
   * costs is the ability to interrupt, which the meter below buys back.
   */
  park() {
    if (this.parked || this.mode !== 'listening') return;
    this.parked = true;
    this.stopRec();
    // A pending turn belongs to what was said BEFORE she started; letting it fire
    // now would answer a question she is already answering.
    clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  unpark() {
    if (!this.parked) return;
    this.parked = false;
    // Whatever was half-heard belongs to the other side of her sentence.
    this.consumedUpTo = 0;
    this.lastHeard = '';
    this.pending = '';
    this.carry = '';
    this.consumeFrom = null;
    setTimeout(() => this.mode === 'listening' && !this.parked && this.startRec(), REOPEN_DELAY_MS);
  }

  /**
   * The barge-in gate, on OUR echo-cancelled stream.
   *
   * Measured in the spike: with the speakers up, what the browser's AEC lets
   * through sits far below a real voice, so a sustained level over the threshold
   * is a person and not her. Sustained, because a door closing is not an
   * interruption.
   */
  startMeter() {
    const ctx = new AudioContext();
    const node = ctx.createAnalyser();
    node.fftSize = 1024;
    ctx.createMediaStreamSource(this.micStream).connect(node);
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
