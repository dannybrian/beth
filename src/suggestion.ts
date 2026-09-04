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

  current(): string | null {
    return this.shown;
  }

  /** The bus message — one shape occupied or empty, so the page has one handler. */
  message(): SuggestionMessage {
    return { type: 'suggestion', text: this.shown };
  }

  /** Her offer. A second offer in the same turn replaces the first. */
  offer(raw: unknown): { ok: true; text: string } | { ok: false; reason: string } {
    const vetted = vetSuggestion(raw);
    if (vetted.ok) this.held = vetted.text;
    return vetted;
  }

  /**
   * A turn began — his reply, a resumed turn, anything. Whatever was showing
   * is an answer to the previous question, and whatever was held belongs to a
   * turn that is no longer the current one. Returns the clearing message when
   * the page has something to drop, null when it was already empty, so a
   * caller publishes only on change.
   */
  turnStarted(): SuggestionMessage | null {
    this.held = null;
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
    return this.turnStarted();
  }
}
