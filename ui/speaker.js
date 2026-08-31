// Her voice, outbound — the playback half of the speech plane.
//
// The whole transport: an HTTP stream into an <audio> element. No session to
// open, no transcript to answer, no mic — which is the entire reason this
// exists, because Speech Engine could only carry a reply to something it heard.
//
// A module for the same reason listen.js is one: the hard part is BOOKKEEPING
// with invisible failures — a queue that wedges, a deliberate stop reported as
// an error, a mute that plays one more line — and a module boundary is what
// lets node drive it with a stubbed <audio> (speaker.test.ts) instead of a
// human driving Chrome.
//
// ONE line at a time. Assigning `src` while a play() is still resolving aborts
// it, and both lines are lost — the browser calls that `AbortError: interrupted
// by a new load request`, and it cost an afternoon in the spike.

/**
 * @param opts.audio  An <audio>-like element. Injectable so tests can stub it;
 *                    the page passes `new Audio()`.
 * @param opts.park   Close the ear — half duplex, she must not hear herself.
 * @param opts.unpark Reopen it, only once she has genuinely finished.
 * @param opts.note   One human-readable line to the activity feed.
 * @param opts.report Line ids that FINISHED — played, refused, or dropped by a
 *                    stop. The harness frees the machine's talking stick on
 *                    this, so every way a line can end must reach it: a line
 *                    that ends silently and unreported holds every other beth
 *                    on the machine quiet until the backstop.
 * @param opts.initialVolume 0..1. Persistence is the caller's business.
 */
export function createSpeaker({ audio, park, unpark, note, report, initialVolume = 1 }) {
  const backlog = [];
  let speakingId = null;
  audio.volume = clamp(initialVolume);

  function playNext() {
    if (speakingId !== null) return;
    const id = backlog.shift();
    if (id === undefined) return;
    speakingId = id;
    // HALF DUPLEX. The ear closes while she talks, because echo cancellation
    // cannot reach the recogniser's own capture — it opens its own microphone
    // and takes no constraints. Parking it is what stops her hearing herself
    // and answering it.
    park?.();
    audio.src = `/api/voice/say/${encodeURIComponent(id)}`;
    audio.play().catch((e) => {
      // A pause() while play() is still resolving rejects it with AbortError —
      // which is barge-in and the mute doing their job, not a line failing. It
      // must not be reported: "stopped speaking" already was, and a 🔇 under it
      // reads as something broken.
      if (e.name === 'AbortError') return;
      // Chrome refuses audio until the page has been interacted with. Say so:
      // silence is indistinguishable from a hang, which is the bug this replaces.
      note?.(`🔇 not spoken — ${e.name === 'NotAllowedError' ? 'click the page once to allow audio' : e.message}`);
      done(id);
    });
  }

  /** Advance exactly once per line, however it ended. */
  function done(id) {
    if (speakingId !== id) return;
    speakingId = null;
    if (id != null) report?.([id]);
    if (backlog.length) return void playNext();
    // Only reopen when she has genuinely finished — between two queued lines
    // the ear would otherwise open into the gap and hear the second one.
    unpark?.();
  }

  audio.addEventListener('ended', () => done(speakingId));
  // A failed fetch (502 from a missing permission, say) must not wedge the
  // queue. The server publishes its own `unspoken` line with the reason.
  audio.addEventListener('error', () => done(speakingId));

  return {
    enqueue(id) {
      backlog.push(id);
      playNext();
    },
    /**
     * Cut her off — barge-in and the mute share this. A backlog she was going
     * to read is no longer wanted: you interrupted the whole thought, not one
     * sentence of it. The transcript still has every word.
     */
    stop() {
      audio.pause();
      // Dropped lines are FINISHED as far as the machine is concerned — the
      // talking stick must not stay held for words nobody will hear.
      const finished = speakingId != null ? [speakingId, ...backlog] : [...backlog];
      const dropped = backlog.length;
      backlog.length = 0;
      speakingId = null;
      if (finished.length) report?.(finished);
      if (dropped) note?.(`⏹ stopped speaking — ${dropped} line${dropped > 1 ? 's' : ''} not read aloud`);
      unpark?.();
    },
    isSpeaking: () => speakingId !== null,
    /** 0..1, clamped. ⚠️ Zero is MUTE, not silence — the line still bills. */
    setVolume(v) {
      audio.volume = clamp(v);
    },
    volume: () => audio.volume,
  };
}

const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));
