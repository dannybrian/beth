// A markdown reader for PLAN BODIES, and nothing else.
//
// Deliberately not `markdown.ts`. That one exists to STRIP markers off what Beth
// writes so link offsets stay stable and TTS does not pronounce asterisks — its
// output is one canonical string with overlays. This is the opposite job: turn a
// file on disk into something to read. Sharing them would put a renderer in the
// path of the speech excerpt, which is how a plan's table ends up being read
// aloud.
//
// The parse is pure and returns plain objects, so it is tested in node; the DOM
// builder below is deliberately dumb. Scope comes from the corpus rather than
// from a spec — measured across 40 of beadgame's unity plans: 1556 bullets, 643
// headings, 503 ordered items, 502 fences, 396 checkboxes, 354 table rows, 310
// quotes. Everything there is handled. Reference-style links, footnotes and
// setext headings are not, because plans do not use them.

// Groups, in order: 1-2 code, 3-4 strong, 5-6 em, 7-8 strike, 9-10 link.
// ⚠️ The alternation order IS the precedence, and the backreferences are numbered
// against it — a renumbering that leaves a `\N` pointing at the wrong group turns
// links into strikethrough with no error anywhere.
const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1|(\*\*|__)(?=\S)([\s\S]*?\S)\3|(\*|_)(?=\S)([\s\S]*?\S)\5|(~~)(?=\S)([\s\S]*?\S)\7|\[([^\]]*)\]\(([^)\s]+)[^)]*\)/;

/**
 * Inline spans, innermost-last. Code wins over emphasis — `**not bold**` inside
 * backticks is a literal, which matters in plans full of shell and regex.
 */
export function parseInline(text) {
  const out = [];
  let rest = String(text);
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push({ t: 'text', v: rest });
      break;
    }
    if (m.index) out.push({ t: 'text', v: rest.slice(0, m.index) });
    if (m[2] !== undefined) out.push({ t: 'code', v: m[2].trim() });
    else if (m[4] !== undefined) out.push({ t: 'strong', c: parseInline(m[4]) });
    else if (m[6] !== undefined) out.push({ t: 'em', c: parseInline(m[6]) });
    else if (m[8] !== undefined) out.push({ t: 'del', c: parseInline(m[8]) });
    else out.push({ t: 'link', href: m[10] ?? '', c: parseInline(m[9] ?? '') });
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const H = /^(#{1,6})\s+(.*)$/;
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const HR = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (line) =>
  line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());

/**
 * Blocks, in order. `frontmatter` is kept rather than dropped: it is where
 * status, priority and depends_on live, and a preview that silently hid them
 * would be a worse view of the plan than `cat`.
 */
export function parseBlocks(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      out.push({ t: 'frontmatter', v: lines.slice(1, end).join('\n') });
      i = end + 1;
    }
  }

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const fence = FENCE.exec(line);
    if (fence) {
      // Closed by a fence of at least the same length — a ``` inside a ````
      // block is content, which is exactly how plans quote markdown.
      const mark = fence[2][0];
      const need = fence[2].length;
      const body = [];
      let closed = false;
      for (i++; i < lines.length; i++) {
        const c = FENCE.exec(lines[i]);
        if (c && c[2][0] === mark && c[2].length >= need && !c[3].trim()) {
          closed = true;
          break;
        }
        body.push(lines[i]);
      }
      out.push({ t: 'code', lang: fence[3].trim(), v: body.join('\n'), unclosed: !closed });
      continue;
    }

    const h = H.exec(line);
    if (h) {
      out.push({ t: 'heading', level: h[1].length, c: parseInline(h[2].trim()) });
      continue;
    }
    if (HR.test(line)) {
      out.push({ t: 'hr' });
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) body.push(QUOTE.exec(lines[i])[1]);
      i--;
      out.push({ t: 'quote', blocks: parseBlocks(body.join('\n')) });
      continue;
    }
    // A table needs its separator row on the NEXT line, which is what stops a
    // prose line containing a pipe from becoming a one-column table.
    if (line.includes('|') && TABLE_SEP.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) {
        rows.push(cells(lines[i]));
      }
      i--;
      out.push({ t: 'table', head: head.map(parseInline), rows: rows.map((r) => r.map(parseInline)) });
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = !BULLET.test(line);
      const baseIndent = (BULLET.exec(line) ?? ORDERED.exec(line))[1].length;
      const items = [];
      let blank = false;
      for (; i < lines.length; i++) {
        const l = lines[i];
        if (!l.trim()) {
          blank = true;
          continue;
        }
        const b = BULLET.exec(l);
        const o = ORDERED.exec(l);
        const indent = b ? b[1].length : o ? o[1].length : /^\s*/.exec(l)[0].length;

        if (b || o) {
          if (indent < baseIndent) break;
          if (indent > baseIndent && items.length) {
            // A deeper marker opens a SUB-LIST: gather everything below this
            // level, dedent it, and let the parser do it again.
            const sub = [];
            for (; i < lines.length; i++) {
              if (!lines[i].trim()) {
                sub.push('');
                continue;
              }
              const n = BULLET.exec(lines[i]) ?? ORDERED.exec(lines[i]);
              const ind = n ? n[1].length : /^\s*/.exec(lines[i])[0].length;
              if (ind <= baseIndent) break;
              sub.push(lines[i].slice(indent));
            }
            i--;
            const last = items[items.length - 1];
            last.sub = (last.sub ?? []).concat(sub);
            blank = false;
            continue;
          }
          items.push({ raw: [b ? b[2] : o[3]] });
          blank = false;
          continue;
        }

        // ⚠️ A LAZY CONTINUATION — a wrapped bullet, which is most of them in a
        // real plan. Without this the tail of every long bullet broke out of the
        // list and rendered as an unindented paragraph: the text was all there,
        // so it read as a formatting quirk rather than a parse failure. Seen on
        // screen before it was seen in the code.
        if (!items.length) break;
        // A gap THEN unindented prose is a new paragraph, not a continuation.
        if (blank && indent <= baseIndent) break;
        items[items.length - 1].raw.push(l.trim());
        blank = false;
      }
      i--;
      out.push({
        t: 'list',
        ordered,
        items: items.map((it) => {
          const text = it.raw.join(' ');
          const task = TASK.exec(text);
          const node = task
            ? { done: task[1].toLowerCase() === 'x', c: parseInline(task[2]) }
            : { c: parseInline(text) };
          if (it.sub) node.blocks = parseBlocks(it.sub.join('\n'));
          return node;
        }),
      });
      continue;
    }

    // A paragraph runs to the blank line or the next block opener.
    const para = [line];
    for (i++; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim() || H.test(l) || FENCE.test(l) || HR.test(l) || QUOTE.test(l) || BULLET.test(l) || ORDERED.test(l)) break;
      para.push(l);
    }
    i--;
    out.push({ t: 'para', c: parseInline(para.join('\n')) });
  }
  return out;
}

// --- the dumb half: blocks to DOM ------------------------------------------
//
// Nodes are BUILT, never innerHTML'd. A plan is a file on disk and its text is
// not ours; the parse above is the only thing that decides structure, and
// nothing downstream can be talked into markup by the content.

const mk = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function inlineInto(parent, nodes, onLink) {
  for (const n of nodes) {
    if (n.t === 'text') parent.append(document.createTextNode(n.v));
    else if (n.t === 'code') parent.append(mk('code', null, n.v));
    else if (n.t === 'link') {
      const a = mk('a');
      a.href = '#';
      a.title = n.href;
      inlineInto(a, n.c, onLink);
      if (!a.textContent) a.textContent = n.href;
      a.onclick = (e) => {
        e.preventDefault();
        onLink?.(n.href);
      };
      parent.append(a);
    } else {
      const tag = n.t === 'strong' ? 'strong' : n.t === 'em' ? 'em' : 's';
      const el = mk(tag);
      inlineInto(el, n.c, onLink);
      parent.append(el);
    }
  }
  return parent;
}

export function renderBlocks(blocks, onLink) {
  const frag = document.createDocumentFragment();
  for (const b of blocks) {
    if (b.t === 'frontmatter') {
      const d = mk('details', 'md-fm');
      d.append(mk('summary', null, 'frontmatter'));
      d.append(mk('pre', null, b.v));
      frag.append(d);
    } else if (b.t === 'heading') {
      frag.append(inlineInto(mk(`h${Math.min(b.level, 6)}`), b.c, onLink));
    } else if (b.t === 'para') {
      frag.append(inlineInto(mk('p'), b.c, onLink));
    } else if (b.t === 'code') {
      const pre = mk('pre', b.unclosed ? 'md-code unclosed' : 'md-code');
      pre.append(mk('code', null, b.v));
      // An unclosed fence is a bug in the PLAN, and saying so beats rendering
      // the rest of the file as one grey block with no explanation.
      if (b.unclosed) pre.title = 'unterminated code fence in the plan';
      frag.append(pre);
    } else if (b.t === 'hr') {
      frag.append(mk('hr'));
    } else if (b.t === 'quote') {
      const q = mk('blockquote');
      q.append(renderBlocks(b.blocks, onLink));
      frag.append(q);
    } else if (b.t === 'list') {
      const list = mk(b.ordered ? 'ol' : 'ul');
      for (const item of b.items) {
        const li = mk('li');
        if (item.done !== undefined) {
          li.className = item.done ? 'task done' : 'task';
          // A real disabled checkbox, so it LOOKS like state rather than text —
          // and cannot be clicked, because the harness does not write plans.
          const box = mk('input');
          box.type = 'checkbox';
          box.checked = item.done;
          box.disabled = true;
          li.append(box);
        }
        inlineInto(li, item.c, onLink);
        if (item.blocks) li.append(renderBlocks(item.blocks, onLink));
        list.append(li);
      }
      frag.append(list);
    } else if (b.t === 'table') {
      const table = mk('table', 'md-table');
      const thead = mk('thead');
      const hr = mk('tr');
      for (const c of b.head) hr.append(inlineInto(mk('th'), c, onLink));
      thead.append(hr);
      table.append(thead);
      const tbody = mk('tbody');
      for (const row of b.rows) {
        const tr = mk('tr');
        for (const c of row) tr.append(inlineInto(mk('td'), c, onLink));
        tbody.append(tr);
      }
      table.append(tbody);
      frag.append(table);
    }
  }
  return frag;
}
