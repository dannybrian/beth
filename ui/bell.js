// The end-of-turn tone.
//
// SYNTHESISED rather than a file: an asset would be the first binary in the repo
// and a fetch that can 404, for eighty milliseconds of sine. Two partials with an
// exponential decay reads as a soft mallet — a bell, not a notification chime,
// because this fires after every turn and anything with an edge on it becomes
// unbearable by the third hour.
//
// A module because its bookkeeping fails silently in both directions: a context
// that never resumes is a bell that simply never rings (and browsers start it
// suspended until a gesture), while a listener that double-fires rings twice on
// one turn. Neither throws.

/** Ratio to the root, and how loud relative to it. A minor third under the root
 *  is what makes it read as a bell rather than a beep. */
const PARTIALS = [
  { ratio: 1, gain: 1 },
  { ratio: 2.4, gain: 0.32 },
];

export function createBell(opts = {}) {
  const Ctx = opts.AudioContext ?? globalThis.AudioContext ?? globalThis.webkitAudioContext;
  let ctx = null;
  // ⚠️ -Infinity, not 0. `currentTime` also starts at 0, so a zero here means the
  // debounce below swallows the very FIRST bell — which is the one that proves
  // the feature works, and its absence looks like the toggle doing nothing.
  let last = -Infinity;

  const ensure = () => {
    if (!Ctx) return null;
    if (!ctx) ctx = new Ctx();
    // Created suspended until the page has been interacted with; resuming is
    // safe to call repeatedly and is what makes the FIRST bell of a session
    // actually sound rather than silently doing nothing.
    if (ctx.state === 'suspended') ctx.resume?.();
    return ctx;
  };

  return {
    /** Called on a real gesture, so the first turn's bell is not the one that unlocks it. */
    unlock: ensure,

    /**
     * @param volume 0..1 — the machine volume, so the bell obeys the same knob
     *        as her voice. Muted is handled by the caller not calling.
     */
    ring(volume = 1) {
      if (!(volume > 0)) return false;
      const c = ensure();
      if (!c || c.state === 'closed') return false;
      // Two turns landing together (a tool result and the turn end) must not
      // ring twice — one bell per moment, whatever the caller does.
      const now = c.currentTime;
      if (now - last < 0.35) return false;
      last = now;

      const out = c.createGain();
      // ⚠️ Loud enough to actually HEAR. The first pass used 0.09, which at a
      // machine volume of 45% is a peak of 0.04 — around 20dB under her voice at
      // the same setting, i.e. inaudible in a room with anything else going on.
      // "Punctuation, not content" is about its SHAPE (short, soft attack, long
      // decay), not about being too quiet to notice.
      out.gain.value = 0.28 * volume;
      out.connect(c.destination);

      for (const p of PARTIALS) {
        const osc = c.createOscillator();
        const g = c.createGain();
        osc.type = 'sine';
        osc.frequency.value = 660 * p.ratio;
        // An exponential ramp to a real floor, not to zero — a ramp to zero is
        // undefined and lands as a click on some engines.
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(p.gain, now + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
        osc.connect(g);
        g.connect(out);
        osc.start(now);
        osc.stop(now + 0.95);
      }
      return true;
    },
  };
}
