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
//
// Tables ride the same overlay (2026-10-04). A table is BLOCK structure, which
// looks like the case for a renderer in the page — but its cells are still
// ranges of one string, so it fits: the canonical text is the cells, tab between
// columns and newline between rows (what a copied table pastes as), and
// `table`/`row`/`th`/`td` spans TILE it. Each range owns its trailing separator,
// which is what keeps the page's DOM text equal to this string character for
// character — reread.js counts on that — and links inside a cell are ordinary
// links, detected after the fact like any other.
export type SpanKind = 'bold' | 'italic' | 'code' | 'strike' | 'heading' | 'table' | 'row' | 'th' | 'td';

/** A formatting range, in the same coordinates as a TextLink. */
export type TextSpan = { start: number; end: number; kind: SpanKind };

export type Rendered = { text: string; spans: TextSpan[] };

/** `# ` … `###### `. The marker goes; the line is marked as a heading. */
const HEADING = /^(#{1,6})[ \t]+/;
/** `- `, `* `, `+ ` at the head of a line. Indent survives; the marker becomes a bullet. */
const BULLET = /^([ \t]*)[-*+][ \t]+/;

/** A fence line. Nothing inside one is a table, however many pipes it has. */
const FENCE = /^\s*(`{3,}|~{3,})/;
/**
 * The row under a table's header: `|---|:--:|`. Requiring it on the NEXT line is
 * what stops a prose line with a pipe in it becoming a one-column table.
 */
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** One row's cells. `\|` is a literal pipe, which is the only way GFM has to write one. */
function tableCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

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
 * Block handling is deliberately thin — headings, bullets and tables. Beth is
 * told to write like someone speaking, and a table is still the wrong answer to
 * a spoken question; but a comparison of nine models IS a table, and it arrived
 * as rows of pipes. Fenced blocks are still left exactly as written.
 */
export function renderInline(src: string): Rendered {
  const spans: TextSpan[] = [];
  let out = '';
  const lines = src.split('\n');
  let fence: string | null = null;
  // A table swallows the newline that ends it, so the next line must not add one.
  let glued = false;

  for (let i = 0; i < lines.length; i++) {
    if (i && !glued) out += '\n';
    glued = false;
    let body = lines[i];

    const f = FENCE.exec(body);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    }

    // Same column count on both lines, as GFM requires: `a | b` over a `---`
    // rule is a sentence and a divider, not a table with one column missing.
    const sep = lines[i + 1] ?? '';
    const isTable =
      !fence && !f && body.includes('|') && TABLE_SEP.test(sep) && tableCells(sep).length === tableCells(body).length;
    if (isTable) {
      let end = i + 2;
      while (end < lines.length && lines[end].trim() && lines[end].includes('|')) end++;
      const rows = [lines[i], ...lines.slice(i + 2, end)].map(tableCells);
      const more = end < lines.length;

      const table: TextSpan = { start: out.length, end: 0, kind: 'table' };
      spans.push(table);
      rows.forEach((cells, r) => {
        const row: TextSpan = { start: out.length, end: 0, kind: 'row' };
        spans.push(row);
        cells.forEach((cell, c) => {
          const base = out.length;
          const inner = scanInline(cell);
          out += inner.text;
          // The separator belongs to the cell BEFORE it. Without that an empty
          // cell is a zero-width range, which the page cannot place.
          if (c < cells.length - 1) out += '\t';
          else if (r < rows.length - 1 || more) out += '\n';
          // The one cell that can still be empty: the last of a table that ends
          // the message. It gets no span — a row one cell short, not a stray.
          if (out.length === base) return;
          spans.push({ start: base, end: out.length, kind: r ? 'td' : 'th' });
          for (const s of inner.spans) spans.push({ start: base + s.start, end: base + s.end, kind: s.kind });
        });
        row.end = out.length;
      });
      table.end = out.length;
      i = end - 1;
      glued = more;
      continue;
    }

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
  }

  return { text: out, spans };
}

/** What Danny HEARS: the same text, with nothing left for TTS to pronounce. */
export function stripMarkdown(src: string): string {
  return renderInline(src).text;
}
