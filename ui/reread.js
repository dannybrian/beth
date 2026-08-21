// The re-read affordance: a faint speaker after each paragraph of what Beth
// writes, so a line half-heard — or never spoken at all: the excerpt rule skips
// most paragraphs, and `off` skips everything — can be pronounced on demand.
//
// The transcript's one rule constrains everything here: a body is built from
// the canonical string plus two offset overlays, so nothing may transform that
// string (see markdown.ts). An icon is therefore an extra NODE spliced in at a
// character offset — the text around it is untouched, and the overlays' offsets
// keep meaning what they meant.
//
// A module for the same reason listen.js is one: the part that goes wrong is
// bookkeeping. A wrong range or a wrong splice does not throw — it draws the
// speaker mid-sentence, or hands the wrong paragraph to the mouth.
// src/reread.test.ts drives both against fake trees.

/**
 * Paragraph slices of `text` as [start,end) OFFSETS, blank-line separated —
 * the same rule as src/spoken.ts, but positional: these have to land inside a
 * DOM built from this exact string, and a trimmed copy would drift.
 */
export function paragraphRanges(text) {
  const ranges = [];
  const push = (start, end) => {
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (end > start) ranges.push({ start, end });
  };
  const sep = /\n\s*\n/g;
  let at = 0;
  for (let m; (m = sep.exec(text)); at = m.index + m[0].length) push(at, m.index);
  push(at, text.length);
  return ranges;
}

/**
 * Splice `node` into `root` at character `offset`, counting TEXT characters
 * only — which is why the invariant above matters: the body's text content IS
 * the canonical string, so a text-only walk lands where the offsets say.
 * Splits a text node when the offset falls inside one (a paragraph ending
 * inside a bold span does).
 */
export function insertAtOffset(root, offset, node) {
  let at = 0;
  const walk = (n) => {
    if (n.nodeType === 3) {
      const len = n.nodeValue.length;
      if (at + len >= offset) {
        n.parentNode.insertBefore(node, n.splitText(offset - at));
        return true;
      }
      at += len;
      return false;
    }
    // Copied first: splitText grows childNodes under a live iteration.
    for (const c of [...n.childNodes]) if (walk(c)) return true;
    return false;
  };
  if (!walk(root)) root.append(node);
}

/**
 * One faint speaker per paragraph. The glyph lives in CSS (`::before`) rather
 * than in the button's text, so the walk above never counts it and a copied
 * selection never contains it. Buttons go in ascending order, which is what
 * keeps the later offsets valid: an already-inserted button contributes zero
 * characters to the count.
 */
export function addRereadButtons(body, text, onRead) {
  for (const r of paragraphRanges(text)) {
    const b = document.createElement('button');
    b.className = 'reread';
    b.title = 'read aloud';
    b.setAttribute('aria-label', 'read this paragraph aloud');
    b.onclick = () => onRead(text.slice(r.start, r.end));
    insertAtOffset(body, r.end, b);
  }
}
