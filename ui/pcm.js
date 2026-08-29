// PCM downsampling as plain math, shared between the AudioWorklet and node.
//
// The browser captures at the AudioContext's rate (usually 48k float32) and
// Scribe wants 16k mono int16. This is the part of the capture path where a
// mistake is INVISIBLE — a resampler that drifts or clips does not error, it
// just makes her mishear him — which is why it lives in a module node can test
// rather than inline in a worklet only Chrome ever runs.

/**
 * Streaming linear-interpolation resampler. Stateful across chunks on purpose:
 * audio arrives in 128-frame worklet blocks, and a resampler that reset its
 * fractional position at each block boundary would warble at exactly the block
 * rate — plausible-sounding and wrong, the usual failure shape here.
 */
export class Downsampler {
  /**
   * @param inRate  capture rate, e.g. 48000
   * @param outRate target rate, 16000 for Scribe
   */
  constructor(inRate, outRate = 16000) {
    if (!(inRate >= outRate)) throw new Error(`cannot upsample ${inRate} → ${outRate}`);
    this.step = inRate / outRate;
    /** Fractional read position within the CURRENT chunk, carried across pushes. */
    this.pos = 0;
    /** Last sample of the previous chunk, for interpolation across the seam. */
    this.prev = 0;
    this.primed = false;
  }

  /**
   * @param {Float32Array} input samples in [-1, 1]
   * @returns {Int16Array} resampled 16-bit PCM (little-endian by platform)
   */
  push(input) {
    if (!input.length) return new Int16Array(0);
    // pos is relative to a virtual stream where index -1 is `prev`.
    const out = [];
    let pos = this.pos;
    while (pos < input.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i === 0 ? (this.primed ? this.prev : input[0]) : input[i - 1];
      const b = input[Math.min(i, input.length - 1)];
      // Interpolate between the sample BEFORE the position and the one at it,
      // so the seam between chunks uses the carried sample rather than a zero.
      out.push(clamp16(a + (b - a) * frac));
      pos += this.step;
    }
    this.pos = pos - input.length;
    this.prev = input[input.length - 1];
    this.primed = true;
    return Int16Array.from(out);
  }
}

/** Float [-1,1] → int16, clipped. Out-of-range input is real (AGC overshoot). */
export function clamp16(f) {
  const s = Math.max(-1, Math.min(1, f));
  return Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
}

/**
 * Accumulate int16 chunks and emit fixed-size batches. Posting every 128-frame
 * block would be ~375 messages a second; the wire wants ~250ms parcels.
 */
export class Batcher {
  constructor(size, onBatch) {
    this.size = size;
    this.onBatch = onBatch;
    this.buf = new Int16Array(size);
    this.fill = 0;
  }

  push(chunk) {
    let off = 0;
    while (off < chunk.length) {
      const n = Math.min(chunk.length - off, this.size - this.fill);
      this.buf.set(chunk.subarray(off, off + n), this.fill);
      this.fill += n;
      off += n;
      if (this.fill === this.size) {
        this.onBatch(this.buf);
        this.buf = new Int16Array(this.size);
        this.fill = 0;
      }
    }
  }

  /** Emit whatever is pending (end of capture). Nothing pending emits nothing. */
  flush() {
    if (!this.fill) return;
    this.onBatch(this.buf.subarray(0, this.fill));
    this.buf = new Int16Array(this.size);
    this.fill = 0;
  }
}
