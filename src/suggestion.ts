// The suggested reply — ONE line she thinks Danny is about to type, offered as
// ghost text in the composer and accepted with Tab. The same affordance Claude
// Code has, with one difference that shapes everything here: it is HER call,
// made with her tool, not a second model asked to guess. A separate prediction
// call would cost a turn's worth of tokens per turn and know less than she
// does about what she just asked.
//
// Not a decision. A queued decision has buttons and waits in the queue; this is
// for the reply that is obvious — "yes, go ahead", "commit it", "run them" —
// where a button would be ceremony and typing it is friction. The tool
// description carries that line; this module carries the lifecycle, which is
// where the invisible mistakes are:
//
//   - It is HELD until her turn ends, not shown when the call lands. She calls
//     the tool somewhere in the middle of a turn and goes on writing, and a
//     ghost reply sitting under a sentence she has not finished is an answer to
//     a question he has not been asked yet.
//   - It belongs to the turn that offered it. Anything that starts a new turn —
//     his reply, a worker's report resuming her, /clear — drops it, shown or
//     held. She offers again if it still applies, which costs her one call and
//     spares the page a stale "yes, go ahead" under an unrelated answer.
//   - A turn that did not end cleanly shows nothing. An interrupted turn was
//     stopped by Danny; a suggestion for it is a suggestion for something he
//     just cut off.
//
// Current state, not transcript: the server sends the live one on connect the
// way it sends the workbench, and the bus keeps it out of the replay.

export type SuggestionMessage = { type: 'suggestion'; text: string | null };

/**
 * A suggestion is a line, and it is going into a one-row box. Anything longer
 * than this is a paragraph she wrote in the wrong place, and refusing it with
 * the reason teaches her faster than a clipped placeholder nobody can read.
 */
export const SUGGESTION_MAX = 160;

/**
 * The opening line, written in his voice and seeded at boot.
 *
 * Fixed SHAPE on purpose, and that is the opposite of the rule her greeting
 * lives under: hers has to be different every morning (greeting.ts) because it
 * is a sentence he READS, while this is a control he USES — one that changed
 * shape each boot would have to be read before it could be taken.
 *
 * The one thing that does move is the time of day, because it is the one thing
 * that would otherwise be WRONG rather than merely repetitive: a clear at four
 * in the afternoon puts a "good morning" in his composer, and a line he has to
 * edit before sending is worse than an empty box. Read at the moment the line
 * is built, never captured — the harness runs for days, so a boot-time answer
 * would still be saying good morning at midnight.
 *
 * ⚠️ The night belongs to the evening. Danny works late, and the alternative to
 * calling 1am "evening" is a fourth branch with something knowing in it, which
 * is a joke that stops being funny the second time it is read.
 */
export function bootSuggestion(name: string, now: Date = new Date()): string {
  const h = now.getHours();
  // ⚠️ The small hours fall through to the evening, which means the afternoon
  // band has to be BOUNDED at both ends — an `h < 18` tail alone wishes him a
  // good afternoon at one in the morning.
  const partOfDay = h >= 5 && h < 12 ? 'good morning' : h >= 12 && h < 18 ? 'good afternoon' : 'good evening';
  return `Hey, ${name}, ${partOfDay}! Bring me up to speed.`;
}

export function vetSuggestion(raw: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string') return { ok: false, reason: 'pass `text`, the reply as he would type it' };
  // One line: newlines and runs of whitespace collapse. A two-line suggestion
  // is two replies, and a placeholder cannot show a line break anyway.
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, reason: 'empty suggestion' };
  if (text.length > SUGGESTION_MAX) {
    return { ok: false, reason: `too long (${text.length} chars, max ${SUGGESTION_MAX}) — a suggestion is one short line` };
  }
  return { ok: true, text };
}

export class Suggestion {
  /** Offered during the turn in flight, not yet on the page. */
  private held: string | null = null;
  /** What the page shows now. */
  private shown: string | null = null;
  /** The boot line, waiting for the greeting turn it answers. See seed(). */
  private seeded: string | null = null;

  current(): string | null {
    return this.shown;
  }

  /** The bus message — one shape occupied or empty, so the page has one handler. */
  message(): SuggestionMessage {
    return { type: 'suggestion', text: this.shown };
  }

  /**
   * The opening line, put there by the harness rather than offered by her
   * (main.ts, bootSuggestion above). The one reply that is always obvious is
   * the FIRST one — bring me up to speed — and a fresh page has no turn she
   * could have offered it in: she is still writing her greeting, and the whole
   * point of the ghost text is that it is already in the box when he arrives.
   *
   * It is a reply to the GREETING, so it is seeded before that turn starts and
   * survives exactly one clearing: `turnStarted` moves it into `held`, and
   * from there it is an ordinary offer — shown when the greeting lands cleanly,
   * dropped if he interrupted it, replaced if she offers something better.
   * ⚠ Seed it only when a greeting is actually going to run. With no boot turn
   * the next turn to end is Danny's own first sentence, and an opening line
   * sitting under that is a reply to nobody.
   */
  seed(raw: unknown): { ok: true; text: string } | { ok: false; reason: string } {
    const vetted = vetSuggestion(raw);
    if (vetted.ok) this.seeded = vetted.text;
    return vetted;
  }

  /** Her offer. A second offer in the same turn replaces the first. */
  offer(raw: unknown): { ok: true; text: string } | { ok: false; reason: string } {
    const vetted = vetSuggestion(raw);
    if (vetted.ok) this.held = vetted.text;
    return vetted;
  }

  /**
   * Show a line at once, with no turn to wait for — the opening line on a
   * conversation that has just been cleared. The difference from boot is that
   * NOTHING is in flight: at boot she is mid-greeting, and ghost text under an
   * unfinished sentence invites a Tab-Enter that lands as an interrupt, but a
   * cleared page has an empty transcript and an idle session, so the reply
   * that is obvious there can simply be sitting in the box. Returns the
   * message when something changed, so a caller publishes only on change.
   */
  show(raw: unknown): SuggestionMessage | null {
    const vetted = vetSuggestion(raw);
    if (!vetted.ok || this.shown === vetted.text) return null;
    this.shown = vetted.text;
    return this.message();
  }

  /**
   * A turn began — his reply, a resumed turn, anything. Whatever was showing
   * is an answer to the previous question, and whatever was held belongs to a
   * turn that is no longer the current one. Returns the clearing message when
   * the page has something to drop, null when it was already empty, so a
   * caller publishes only on change.
   */
  turnStarted(): SuggestionMessage | null {
    // The boot seed answers the turn now BEGINNING — her greeting — not the one
    // that just ended, so it survives this clearing by becoming what is held.
    // Exactly this one: `seeded` is spent here and every later turn finds it
    // empty, which is the same as the old `this.held = null`.
    this.held = this.seeded;
    this.seeded = null;
    if (this.shown === null) return null;
    this.shown = null;
    return this.message();
  }

  /**
   * A turn ended. Only a CLEAN end shows what was held: an interrupted or
   * errored turn drops it. Returns the message to publish, or null when there
   * is nothing new to show.
   */
  turnEnded(clean: boolean): SuggestionMessage | null {
    const held = this.held;
    this.held = null;
    if (!clean || held === null) return null;
    this.shown = held;
    return this.message();
  }

  /** Everything gone — /clear. Same contract as turnStarted. */
  reset(): SuggestionMessage | null {
    // Everything means the seed too: a clear leaves no greeting for it to be
    // the reply to.
    this.seeded = null;
    return this.turnStarted();
  }
}
