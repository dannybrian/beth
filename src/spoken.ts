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
export type SpeechLevel = 'full' | 'brief' | 'headings' | 'headlines' | 'off';

// Loudest to quietest, which is the order the dropdown draws them in. `headings`
// sits where it does because it is a SHAPE rather than a volume: it can be more
// lines than `headlines` on a structured reply and none at all on a chatty one.
export const SPEECH_LEVELS: SpeechLevel[] = ['full', 'brief', 'headings', 'headlines', 'off'];

/**
 * The dial, as everything that can turn it sees it — the strip through
 * `/api/speech`, and Beth herself through the `speech` tool. Narrow on purpose:
 * who holds it (SpeakOut) is nobody else's business.
 */
/**
 * The dial the session holds over the speech plane.
 *
 * `setVoice` is optional because the level is the part every caller needs and
 * the voice is the part only a persona switch touches — a test driving speech
 * levels should not have to know that directors have voices.
 */
export type SpeechControl = {
  level: () => SpeechLevel;
  set: (level: SpeechLevel) => void;
  /** null restores the machine's own HARNESS_VOICE_ID. */
  setVoice?: (voiceId: string | null) => void;
};

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

/** `# Heading`, at any depth. Bold-only lines are NOT headings — she bolds mid-sentence. */
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * The headings in a reply, in order — the SHAPE of what she just did.
 *
 * A different question from every other level, which all ask "how much prose".
 * This one asks "what were the parts", so a long structured reply reads as four
 * short phrases and an unstructured one reads as nothing at all. That silence is
 * the feature: prose with no headings had no skeleton worth hearing.
 *
 * ⚠️ Fences are skipped. Plans and diffs are full of `# comment` lines, and a
 * shell comment read aloud as a section title is worse than saying nothing.
 */
export function headingsOf(text: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of String(text).split('\n')) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = HEADING.exec(line);
    // Markers come off for speech: "##" is not a word.
    if (m) out.push(m[2].replace(/[*_`]/g, '').trim());
  }
  return out.filter(Boolean);
}

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
    // At both quiet levels a `say` survives only if it is an ANNOUNCEMENT.
    // `headings` keeps them for the same reason it keeps headings: a finding is
    // a beat in the progress model, and status narration is not.
    const quiet = level === 'headlines' || level === 'headings';
    return quiet && !HEADLINE_KINDS.has(m.kind ?? '') ? '' : text;
  }

  if (level === 'headings') {
    // Joined into one line so the mouth speaks them as a sentence rather than
    // holding the stick across four separate lines with gaps between them.
    return headingsOf(text).join('. ');
  }

  if (level === 'headlines') {
    // Only the short in-progress lines survive — a long reply is read on the page.
    return paragraphs(text).length === 1 && text.length <= SHORT_ENOUGH ? text : '';
  }
  return lastParagraph(text);
}

/**
 * A decision landing in the queue, as one spoken line.
 *
 * This is the gap that made `headlines` feel arbitrary: a queued decision never
 * reached the speech path at ALL — `speakOut` only ever subscribed to `assistant`
 * and `say` — so the one thing genuinely waiting on Danny was the one thing never
 * said out loud. It speaks at every level except `off`, because it is a summons
 * rather than narration, and a summons you have to go and look for is a queue you
 * learn to ignore.
 */
export function spokenForDecision(d: { title: string; urgency?: string }, level: SpeechLevel): string {
  if (level === 'off') return '';
  const title = (d.title ?? '').trim();
  if (!title) return '';
  // "blocking-later" is the one urgency worth pronouncing: the other two are
  // exactly what a queue already means.
  const lead = d.urgency === 'blocking-later' ? 'A decision that blocks later' : 'A decision for you';
  return `${lead}: ${title.replace(/\s+/g, ' ')}`;
}
