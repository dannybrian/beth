// The wire panel — what actually happens, drawn from what wireTap.ts kept.
//
// A module for two reasons. It is self-contained by design: it talks to the
// rest of the page through one callback and a poll, and nothing else reads its
// state. And its math is exactly the kind that renders PLAUSIBLY WRONG with no
// error anywhere — an anatomy strip whose segments land a little off looks
// like a fact about the turn, not a bug — so the math is exported pure and
// tested in node (wire.test.ts), the same trade listen.js and speaker.js make.
//
// Everything is PULLED while the panel is open (GET /api/wire, on a cursor).
// None of it rides the stream, the replay, or the page while the panel is
// closed — that is the no-flooding requirement held structurally.

export const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
export const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

/** Group the flat entry list into turns, newest first. */
export function groupTurns(entries) {
  const turns = new Map();
  for (const e of entries) {
    if (!turns.has(e.turn)) turns.set(e.turn, []);
    turns.get(e.turn).push(e);
  }
  return [...turns.entries()].sort((a, b) => b[0] - a[0]);
}

/**
 * The anatomy strip's segments: wall time, attributed to who had the floor.
 *
 * thinking/writing come from the stream-event block boundaries inside each
 * request; tools from the gap between a request completing and its results
 * arriving. Purely positional — nothing is measured beyond timestamps that
 * already exist, and a request with no block data (partial messages off, or an
 * old buffer) renders whole as writing rather than vanishing.
 */
export function anatomySpans(entries) {
  const spans = [];
  for (const e of entries) {
    if (e.kind === 'request') {
      const end = e.ts;
      const blocks = e.blocks?.length ? e.blocks : [{ type: 'text', at: e.startAt }];
      for (let j = 0; j < blocks.length; j++) {
        const b = blocks[j];
        const to = blocks[j + 1]?.at ?? end;
        if (to > b.at) spans.push({ kind: b.type === 'thinking' ? 'think' : 'write', from: b.at, to });
      }
    } else if (e.kind === 'tool_result' && e.sinceMs > 0) {
      spans.push({ kind: 'tool', from: e.ts - e.sinceMs, to: e.ts });
    }
  }
  if (!spans.length) return null;
  const t0 = spans[0].from;
  const total = Math.max(1, spans[spans.length - 1].to - t0);
  const sums = { think: 0, write: 0, tool: 0 };
  for (const s of spans) sums[s.kind] += s.to - s.from;
  return { spans, t0, total, sums };
}

/** The token bars' shared scale and the summary line's two numbers. */
export function tokenSummary(reqs) {
  const totalOf = (r) => r.usage.cacheR + r.usage.cacheW + r.usage.in + r.usage.out;
  const max = Math.max(...reqs.map(totalOf));
  const moved = reqs.reduce((n, r) => n + totalOf(r), 0);
  const cached = reqs.reduce((n, r) => n + r.usage.cacheR, 0);
  return { max, moved, cachedPct: moved ? Math.round((cached / moved) * 100) : 0 };
}

/**
 * The panel itself. `el` is the page's element helper, passed in rather than
 * duplicated; `isTurnInFlight` is the one piece of page state a summary line
 * borrows.
 */
export function createWirePanel({ box, el, isTurnInFlight }) {
  let open = false;
  let seq = 0;
  let entries = [];
  let timer = null;

  async function poll() {
    const r = await fetch(`/api/wire?since=${seq}`).then((x) => x.json()).catch(() => null);
    if (!r) return;
    const had = seq;
    seq = r.seq;
    if (!r.entries.length && had) return;
    entries.push(...r.entries);
    if (entries.length > 800) entries.splice(0, entries.length - 800);
    render();
  }

  function anatomy(turnEntries) {
    const a = anatomySpans(turnEntries);
    if (!a) return null;
    const strip = el('div', 'w-strip');
    let prevEnd = a.t0;
    for (const s of a.spans) {
      const seg = el('i', `w-${s.kind}`);
      seg.style.width = `${((s.to - s.from) / a.total) * 100}%`;
      // Gaps (waiting on the API) render as track background showing through.
      seg.style.marginLeft = `${(Math.max(0, s.from - prevEnd) / a.total) * 100}%`;
      prevEnd = Math.max(prevEnd, s.to);
      strip.append(seg);
    }
    const legend = el('div', 'w-legend');
    for (const [key, cls, label] of [['think', 'w-think', 'thinking'], ['write', 'w-write', 'writing'], ['tool', 'w-tool', 'tools']]) {
      legend.append(el('i', `w-dot ${cls}`), document.createTextNode(` ${label} ${fmtMs(a.sums[key])}  `));
    }
    const wrap = el('div');
    wrap.append(strip, legend);
    return wrap;
  }

  function tokens(turnEntries) {
    const reqs = turnEntries.filter((e) => e.kind === 'request');
    if (!reqs.length) return null;
    const { max, moved, cachedPct } = tokenSummary(reqs);
    const grid = el('div', 'w-tokens');
    reqs.forEach((r, i) => {
      const total = r.usage.cacheR + r.usage.cacheW + r.usage.in + r.usage.out;
      grid.append(el('span', 'w-k', `#${i + 1}`));
      const bar = el('div', 'w-bar');
      for (const [key, cls] of [['cacheR', 'w-cr'], ['cacheW', 'w-cw'], ['in', 'w-in'], ['out', 'w-out']]) {
        if (!r.usage[key]) continue;
        const seg = el('i', cls);
        seg.style.width = `${(r.usage[key] / max) * 100}%`;
        seg.title = `${key === 'cacheR' ? 'cache read' : key === 'cacheW' ? 'cache write' : key === 'in' ? 'fresh input' : 'output'} ${fmtTok(r.usage[key])}`;
        bar.append(seg);
      }
      grid.append(bar);
      grid.append(el('span', 'w-v', `${fmtTok(total)}${r.ttftMs ? ` · ${fmtMs(r.ttftMs)}` : ''}`));
    });
    const legend = el('div', 'w-legend');
    for (const [cls, label] of [['w-cr', 'cache read'], ['w-cw', 'cache write'], ['w-in', 'fresh in'], ['w-out', 'out']]) {
      legend.append(el('i', `w-dot ${cls}`), document.createTextNode(` ${label}  `));
    }
    const wrap = el('div');
    wrap.append(grid, legend);
    wrap.append(el('div', 'w-sum', `${fmtTok(moved)} tokens moved · ${cachedPct}% cache reads`));
    return wrap;
  }

  /** The raw exchange, chronological — the conversation the transcript hides. */
  function exchange(turnEntries) {
    const list = el('div', 'w-exchange');
    for (const e of turnEntries) {
      if (e.kind === 'user') list.append(el('div', 'w-line w-user', `→ ${e.text}`));
      else if (e.kind === 'request') {
        for (const t of e.thinking) list.append(el('div', 'w-line w-thk', `▸ thinking  ${t}`));
        for (const t of e.text) list.append(el('div', 'w-line w-txt', `${t}`));
        for (const t of e.tools) list.append(el('div', 'w-line w-toolcall', `⚙ ${t.name}  ${t.input}`));
      } else if (e.kind === 'tool_result') {
        const line = el('div', `w-line w-res${e.isError ? ' w-err' : ''}`);
        line.textContent = `↳ ${e.isError ? 'error' : 'result'} · ${fmtMs(e.sinceMs)} · ${(e.bytes / 1024).toFixed(1)} KB`;
        if (e.preview) {
          line.classList.add('w-open');
          const body = el('div', 'w-preview', e.preview);
          body.hidden = true;
          line.onclick = () => (body.hidden = !body.hidden);
          list.append(line, body);
          continue;
        }
        list.append(line);
      } else if (e.kind === 'result') {
        list.append(
          el(
            'div',
            'w-line w-final',
            `■ ${e.isError ? 'ERROR' : 'done'} · ${e.requests} request${e.requests === 1 ? '' : 's'} · ${fmtMs(e.durationMs)} (${fmtMs(e.apiMs)} api) · in ${fmtTok(e.usage.in)} · cached ${fmtTok(e.usage.cacheR)} · out ${fmtTok(e.usage.out)}`
          )
        );
      } else if (e.kind === 'event') {
        list.append(el('div', 'w-line w-evt', `⚠ ${e.label}${e.detail ? ` — ${e.detail}` : ''}`));
      }
    }
    return list;
  }

  function render() {
    if (!open) return;
    // The poll rebuilds this while it is being READ, so which turns are
    // expanded must survive the rebuild — losing your place every two seconds
    // mid-demonstration is the panel undermining its own point.
    const openTurns = new Set([...box.querySelectorAll('details[open]')].map((d) => d.dataset.turn));
    const hadAny = box.querySelector('details') !== null;
    box.replaceChildren();
    box.append(el('h3', null, 'The wire — what actually happens'));
    const turns = groupTurns(entries);
    if (!turns.length) {
      box.append(el('div', 'snote', 'nothing captured yet — say something'));
      return;
    }
    turns.forEach(([turn, turnEntries], i) => {
      const d = document.createElement('details');
      d.dataset.turn = String(turn);
      // Newest turn open on first render; after that, wherever Danny left things.
      d.open = hadAny ? openTurns.has(String(turn)) : i === 0;
      const summary = document.createElement('summary');
      const user = turnEntries.find((e) => e.kind === 'user');
      const result = turnEntries.find((e) => e.kind === 'result');
      const reqs = turnEntries.filter((e) => e.kind === 'request').length;
      summary.textContent = `turn ${turn} — ${user ? `“${user.text.slice(0, 60)}”` : '(boot)'}${
        result ? ` · ${fmtMs(result.durationMs)} · ${reqs} req` : isTurnInFlight() && i === 0 ? ' · in flight' : ''
      }`;
      d.append(summary);
      const a = anatomy(turnEntries);
      const t = tokens(turnEntries);
      if (a) d.append(el('h4', 'w-h', 'anatomy'), a);
      if (t) d.append(el('h4', 'w-h', 'tokens'), t);
      d.append(el('h4', 'w-h', 'exchange'), exchange(turnEntries));
      box.append(d);
    });
  }

  return {
    toggle() {
      open = !open;
      box.hidden = !open;
      if (!open) {
        clearInterval(timer);
        timer = null;
        return;
      }
      // Fresh pull on every open — the buffer may have moved a long way while
      // nobody was looking, and a stale cursor would render a gap as history.
      seq = 0;
      entries = [];
      void poll();
      timer = setInterval(poll, 2000);
    },
  };
}
