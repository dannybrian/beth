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
    this.micStream = null;
    this.meterTimer = null;
    this.overSince = 0;
    this.settleMs = opts.settleMs || SETTLE_MS;
    this.dictation = true;
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

  async off() {
    this.mode = 'off';
    this.parked = false;
    this.stopRec();
    clearTimeout(this.settleTimer);
    this.settleTimer = null;
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
    r.onresult = (e) => this.rec === r && this.onResult(e);
    r.onerror = (e) => {
      // `no-speech` is ordinary — it is what a session timing out in silence says.
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      this.opts.onState?.(this.mode === 'off' ? 'off' : 'error', e.error);
    };
    r.onend = () => {
      if (this.rec !== r) return;
      this.rec = null;
      if (this.mode === 'listening' && !this.parked) this.startRec();
    };
    try {
      r.start();
    } catch (e) {
      this.rec = null;
      this.opts.onState?.('error', String(e));
    }
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
    let text = '';
    let allFinal = true;
    for (let i = this.consumedUpTo; i < e.results.length; i++) {
      text += e.results[i][0].transcript;
      if (!e.results[i].isFinal) allFinal = false;
    }
    text = text.trim();
    const shown = text && this.dictation ? punctuate(text) : text;
    this.opts.onInterim?.(shown);
    if (!text) return;

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
    const changed = text !== this.lastHeard;
    this.lastHeard = text;
    this.pending = text;
    // Restart only when the words moved, or when going final SHORTENS the wait.
    if (!changed && wait >= this.timerWait && this.settleTimer) return;
    clearTimeout(this.settleTimer);
    this.timerWait = wait;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.timerWait = 0;
      this.lastHeard = '';
      this.consumedUpTo = e.results.length;
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
