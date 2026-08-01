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
 * What Danny hears. Identity today — the tags pass through to TTS untouched.
 * If the configured Speech Engine model turns out not to support v3 audio tags
 * (realtime engines often run Flash/Turbo for latency), flip this to strip as
 * well, so the voice falls silent on the cue rather than reading "bracket laughs".
 */
export function forVoice(text: string, tagsSupported = true): string {
  return tagsSupported ? text : stripAudioTags(text);
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
].join(' ');
