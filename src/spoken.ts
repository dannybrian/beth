// How much of what she WRITES is what she SAYS.
//
// The two channels have different budgets. A page can carry six paragraphs of
// real code work and Danny skims them in seconds; the same thing read aloud is
// ninety seconds he cannot skip, cannot skim, and cannot interrupt without
// stopping her. So the speech path takes an excerpt, and the transcript keeps
// everything — nothing is lost, it is just not all pronounced.
//
// The excerpt rule is positional rather than clever: the LAST paragraph. It is
// where the upshot lives in anything she writes ("so the two boxes are stale",
// "shipped as 407e186f"), a one-line progress note is its own last paragraph, and
// there is no summarising step to get wrong or to pay for.
export type SpeechLevel = 'full' | 'brief' | 'headlines' | 'off';

export const SPEECH_LEVELS: SpeechLevel[] = ['full', 'brief', 'headlines', 'off'];

/**
 * What she says when a level would otherwise leave a SPOKEN turn with nothing.
 *
 * It cannot be silence: a response with zero chunks makes ElevenLabs re-deliver
 * the transcript, which is the re-delivery loop. So 'off' still costs one short
 * line per thing you say out loud — and that line's job is to tell you where the
 * answer went.
 */
export const SILENT_ACK = 'On the page.';

/**
 * `say` kinds that are ANNOUNCEMENTS rather than narration — a result, not
 * progress. What survives at the quietest level.
 */
const HEADLINE_KINDS = new Set(['finding', 'event']);

/**
 * Longest single-paragraph reply still read aloud at `headlines`. Sized for the
 * in-progress one-liners ("Let me read it and see what those last two tasks
 * are") and against anything that has become an explanation.
 */
const SHORT_ENOUGH = 240;

/** Blocks separated by a blank line, empties dropped. */
const paragraphs = (text: string): string[] =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

/** A block that is a list or a heading — legible on a page, awful read aloud. */
const isStructural = (block: string): boolean =>
  block.split('\n').every((line) => /^\s*(?:[-*+•]|\d+[.)]|#{1,6}\s|\|)/.test(line.trim() ? line : 'x'));

/**
 * The paragraph carrying the point. Prefers the last PROSE block: a reply that
 * ends in a checklist means the sentence before it is the part worth hearing.
 */
export function lastParagraph(text: string): string {
  const blocks = paragraphs(text);
  if (blocks.length <= 1) return text.trim();
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (!isStructural(blocks[i])) return blocks[i];
  }
  return blocks[blocks.length - 1];
}

/** Last resort when the level would otherwise leave a spoken turn with nothing. */
export function lastSentence(text: string): string {
  const para = lastParagraph(text);
  const sentences = para.match(/[^.!?]+[.!?]+(?=\s|$)/g);
  return (sentences?.at(-1) ?? para).trim();
}

/**
 * What to speak for one bus message — '' means say nothing, and the transcript
 * still shows it in full.
 *
 * `say` items are exempt from the excerpt rule at every level above headlines:
 * they are one item per call with a first sentence that stands alone, which is
 * the shape this would otherwise have to impose.
 */
export function spokenFor(m: { type: 'assistant' | 'say'; kind?: string; text: string }, level: SpeechLevel): string {
  const text = (m.text ?? '').trim();
  if (!text) return '';
  if (level === 'off') return '';
  if (level === 'full') return text;

  if (m.type === 'say') {
    return level === 'headlines' && !HEADLINE_KINDS.has(m.kind ?? '') ? '' : text;
  }

  if (level === 'headlines') {
    // Only the short in-progress lines survive — a long reply is read on the page.
    return paragraphs(text).length === 1 && text.length <= SHORT_ENOUGH ? text : '';
  }
  return lastParagraph(text);
}
