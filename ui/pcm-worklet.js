// The AudioWorklet processor: capture-rate float32 in, 16k int16 parcels out.
//
// All the math lives in pcm.js where node can test it; this file is only the
// plumbing Chrome requires — a processor class registered on the audio thread,
// posting batches back to capture.js. Worklet modules are ES modules, so the
// import is ordinary.
import { Downsampler, Batcher } from './pcm.js';

/** ~250ms at 16k. The wire wants parcels, not 128-frame confetti. */
const BATCH_SAMPLES = 4096;

class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.down = new Downsampler(sampleRate, 16000);
    this.batch = new Batcher(BATCH_SAMPLES, (b) => {
      // Copy before transfer: the batcher reuses nothing, but subarray views
      // share the buffer that the next batch would overwrite.
      const out = Int16Array.from(b);
      this.port.postMessage(out, [out.buffer]);
    });
    this.dead = false;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this.dead = true;
    };
  }

  process(inputs) {
    if (this.dead) return false;
    const ch = inputs[0]?.[0];
    if (ch?.length) this.batch.push(this.down.push(ch));
    return true;
  }
}

registerProcessor('pcm-tap', PcmTap);
