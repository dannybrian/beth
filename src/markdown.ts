// Inline markdown — removed from the text, kept as an OVERLAY.
//
// Beth writes ordinary markdown: the Claude Code preset tells her she is rendered
// as GitHub-flavoured markdown, and arguing with the base prompt buys nothing.
// Nothing here rendered it, so `**like this**` reached the page as asterisks —
// and reached ElevenLabs as asterisks too, which the voice either mangles or
// reads out.
//
// The obvious fix — render markdown in the browser — is wrong for this codebase.
// File links are already character RANGES into the message text (links.ts),
// computed on the server against the exact string the page receives. Any
// transform in the page moves those offsets out from under them.
//
// So the markers come off HERE, before links are detected, and what they meant
// travels as spans over the stripped text — the same shape links already use. One
// canonical string, two overlays that agree by construction. The voice path takes
// that string and never learns spans exist.
export type SpanKind = 'bold' | 'italic' | 'code' | 'strike' | 'heading';

/** A formatting range, in the same coordinates as a TextLink. */
export type TextSpan = { start: number; end: number; kind: SpanKind };

export type Rendered = { text: string; spans: TextSpan[] };

/** `# ` … `###### `. The marker goes; the line is marked as a heading. */
const HEADING = /^(#{1,6})[ \t]+/;
/** `- `, `* `, `+ ` at the head of a line. Indent survives; the marker becomes a bullet. */
const BULLET = /^([ \t]*)[-*+][ \t]+/;

type Rule = {
  /** null = consume the match and emit its text with no formatting (an escape). */
  kind: SpanKind | null;
  re: RegExp;
  /**
   * Refuse to open when the preceding character is a word character. This is what
   * keeps `snake_case_names` and `2*3*4` out of italics — the cases that make a
   * naive stripper worse than no stripper at all.
   */
  wordSafe?: boolean;
};

// Order matters: code first, because nothing inside a code span is markup, and
// the two-character markers before their one-character prefixes. Every emphasis
// body must start and end on a non-space, which is the standard rule and also
// what stops a lone asterisk from swallowing the rest of the line.
const RULES: Rule[] = [
  { kind: null, re: /\\([\\`*_~#])/y },
  { kind: 'code', re: /`([^`\n]+)`/y },
  { kind: 'bold', re: /\*\*(\S(?:.*?\S)?)\*\*/y },
  { kind: 'bold', re: /__(\S(?:.*?\S)?)__/y, wordSafe: true },
  { kind: 'strike', re: /~~(\S(?:.*?\S)?)~~/y },
  { kind: 'italic', re: /\*(\S(?:.*?\S)?)\*/y, wordSafe: true },
  { kind: 'italic', re: /_(\S(?:.*?\S)?)_/y, wordSafe: true },
];

/** One line's worth of inline markup. Recurses, so `**bold with `code`**` nests. */
function scanInline(src: string): Rendered {
  let text = '';
  const spans: TextSpan[] = [];
  let i = 0;

  while (i < src.length) {
    let matched = false;
    for (const rule of RULES) {
      if (rule.wordSafe && i > 0 && /\w/.test(src[i - 1])) continue;
      rule.re.lastIndex = i;
      const m = rule.re.exec(src);
      if (!m) continue;

      const start = text.length;
      if (rule.kind === null || rule.kind === 'code') {
        // An escape yields its character; a code span is literal by definition.
        text += m[1];
      } else {
        const inner = scanInline(m[1]);
        text += inner.text;
        for (const s of inner.spans) spans.push({ start: start + s.start, end: start + s.end, kind: s.kind });
      }
      if (rule.kind) spans.push({ start, end: text.length, kind: rule.kind });
      i += m[0].length;
      matched = true;
      break;
    }
    if (!matched) {
      text += src[i];
      i += 1;
    }
  }

  return { text, spans };
}

/**
 * Strip markdown markers from `src`, returning the plain text and the formatting
 * that was carried by the markers. Offsets index the RETURNED text.
 *
 * Block handling is deliberately thin — headings and bullets only. Beth is told
 * to write like someone speaking, so anything more (tables, fenced blocks) is a
 * prompt problem, not a rendering one.
 */
export function renderInline(src: string): Rendered {
  const spans: TextSpan[] = [];
  let out = '';

  src.split('\n').forEach((line, i) => {
    if (i) out += '\n';
    let body = line;

    const h = HEADING.exec(body);
    if (h) {
      body = body.slice(h[0].length);
    } else {
      const b = BULLET.exec(body);
      // A bullet has to survive as SOMETHING: dropping the marker turns a list
      // into run-on lines, and leaving "-" reads as a dash mid-sentence.
      if (b) {
        out += `${b[1]}• `;
        body = body.slice(b[0].length);
      }
    }

    const base = out.length;
    const inner = scanInline(body);
    out += inner.text;
    for (const s of inner.spans) spans.push({ start: base + s.start, end: base + s.end, kind: s.kind });
    if (h && inner.text) spans.push({ start: base, end: base + inner.text.length, kind: 'heading' });
  });

  return { text: out, spans };
}

/** What Danny HEARS: the same text, with nothing left for TTS to pronounce. */
export function stripMarkdown(src: string): string {
  return renderInline(src).text;
}
