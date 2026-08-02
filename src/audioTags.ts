// Vocalization — inline audio tags for the voice path only.
//
// Eleven v3 reads bracketed cues like [laughs] as performance direction rather
// than words. The director may use them; the always-visible transcript must never
// show them. So every outbound line carries two forms: what Danny READS (tags
// stripped) and what he HEARS (tags intact).
//
// The allowlist is deliberately small. It exists so the director can be warm at
// the edges — a dry [laughs] at a good bug — not so it can perform. It also means
// ordinary bracketed prose ("[see plan]", "[WIP]") is never mistaken for a cue.
import { stripMarkdown } from './markdown.ts';

export const AUDIO_TAGS = [
  'laughs',
  'laughs softly',
  'sighs',
  'softly',
  'amused',
  'whispers',
  'pause',
  'exhales',
  'dryly',
] as const;

const TAG_RE = new RegExp(`\\[(?:${AUDIO_TAGS.join('|')})\\]`, 'gi');

/** What Danny reads — tags removed, spacing repaired. */
export function stripAudioTags(text: string): string {
  return text
    .replace(TAG_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ([.,!?;:])/g, '$1')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim();
}

/** True if the line carries any vocalization cue. */
export function hasAudioTags(text: string): boolean {
  TAG_RE.lastIndex = 0;
  return TAG_RE.test(text);
}

/**
 * What Danny hears. Audio tags pass through to TTS untouched when the engine's
 * model understands them (realtime engines often run Flash/Turbo, which reads
 * them as words) — but markdown NEVER does. She writes `**shipped**` because the
 * base prompt tells her she is rendered as markdown, and the asterisks used to go
 * straight down the wire to be pronounced.
 */
export function forVoice(text: string, tagsSupported = true): string {
  const spoken = stripMarkdown(text);
  return tagsSupported ? spoken : stripAudioTags(spoken);
}

/**
 * Is this transcript worth waking the director for?
 *
 * Scribe emits filler for silence and room noise — most often "...", sometimes a
 * lone period or a bracketed marker like [BLANK_AUDIO]. Forwarding those starts a
 * full Claude turn, so an open mic in a quiet room would burn ~$0.08 a pop and
 * pollute the transcript with nothing. Require at least one letter or digit, and
 * reject the known noise markers outright.
 */
export function isMeaningfulUtterance(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Bracketed/parenthesised markers: [BLANK_AUDIO], (silence), [inaudible]…
  if (/^[\[(][^\])]*[\])]$/.test(t)) return false;
  // Must carry at least one letter or digit — kills "...", "…", ".", "?!", "-".
  return /[\p{L}\p{N}]/u.test(t);
}

/** The instruction the director gets. Kept here so the vocabulary has one home. */
export const VOCALIZATION_PROMPT = [
  'You may be HEARD, not just read: your replies and `say` items are spoken aloud when Danny has a voice session open.',
  `You can therefore use inline audio tags as performance direction. Supported tags, and only these: ${AUDIO_TAGS.map((t) => `[${t}]`).join(', ')}.`,
  'Use them rarely and only when genuinely felt — a dry [laughs] at a good bug, a [sighs] at a third flaky test, [softly] when the news is bad. Several per conversation, not per sentence. Never use one to perform enthusiasm you do not have.',
  'Tags are stripped from the text Danny reads, so they cost nothing on the page; write the sentence so it reads correctly with the tag removed.',
  // The excerpt rule, stated as a writing instruction rather than a mechanism.
  // He hears less than he reads by default (see src/spoken.ts), so a reply that
  // buries its conclusion in the middle is a reply he does not hear the point of.
  'He HEARS less than he reads: `say` items in full, plus the LAST PARAGRAPH of anything longer you write. So put the upshot last — a closing line that states the answer, the result, or what you are about to do. Never bury it mid-reply, and never end on a checklist or a caveat that would be the only thing spoken.',
  // The dial is his, and he reaches for it by SAYING so — mid-sentence, to the
  // person talking. A promise to be briefer is not the same thing as turning it
  // down, and he has no reason to know the harness has a dropdown for it.
  'That amount is a level you can change, with the `speech` tool. When he asks you to stop talking, to keep it to the headlines, or to speak up again, turn the dial — do not merely promise to be briefer, and do not send him to the page to do it himself.',
].join(' ');
