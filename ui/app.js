// Minimal vanilla UI — no framework, no build step. The plan calls for
// "Lit/vanilla"; at this size vanilla DOM keeps the dependency count at zero.
import { Listener, listenSupported } from '/listen.js';
import { RemoteEar } from '/remoteEar.js';
import { createSpeaker } from '/speaker.js';
import { createWirePanel } from '/wire.js';
import { addRereadButtons } from '/reread.js';
const $ = (id) => document.getElementById(id);
const transcript = $('transcript');
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let stick = true;
transcript.addEventListener('scroll', () => {
  stick = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 60;
});
function add(node) {
  transcript.append(node);
  if (stick) transcript.scrollTop = transcript.scrollHeight;
  return node;
}

const post = (path, body) =>
  fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

// --- renderers -------------------------------------------------------------

function entry(kind, build) {
  const n = el('div', `entry ${kind}`);
  build(n);
  return add(n);
}

const renderUser = (m) =>
  entry('user', (n) => {
    // Show what he pointed at next to what he typed — a turn that was mostly a
    // gesture should still read as one later.
    if (m.refs?.length) {
      const row = el('div', 'refs sent');
      for (const r of m.refs) row.append(el('span', `chip ${r.kind}`, r.spoken));
      n.append(row);
    }
    n.append(el('div', 'body', m.text));
  });
// --- file links in what Beth writes ------------------------------------------
//
// The server proved each of these resolves before sending it, so a link here is
// never a guess. Click opens the file where the work happens; Cmd/Ctrl-click on
// a plan points Beth at it instead, which is the same gesture as the panel.

/** The bound repo's absolute path, from `hello` — needed to build editor URLs. */
let repoPath = '';
/** Whether this repo is on github.com at all. No remote, no button. */
let repoOnWeb = false;

function openInEditor(link) {
  // vscode://file/<abs>[:line] is a well-defined scheme and needs no local server.
  const abs = `${repoPath}/${link.path}`;
  window.location.href = `vscode://file${abs}${link.line ? `:${link.line}` : ''}`;
}

/** A proven file link that is a picture. An image is looked at, not edited. */
const IMAGE_LINK = /\.(png|jpe?g|gif|webp|svg|avif)$/i;

function linkNode(link, label) {
  // `label` is optional: inside a message body the anchor's contents are built
  // from the range tree below, because a link may itself contain formatting.
  const a = el('a', `filelink ${link.kind}`, label);
  a.href = '#';
  // The server proved this resolves, so an image path gets the lightbox rather
  // than VSCode — she does not even need the `show` tool for a casual mention.
  if (link.kind === 'file' && IMAGE_LINK.test(link.path)) {
    a.title = `${link.path}\nClick to view`;
    a.onclick = (e) => {
      e.preventDefault();
      openLightbox(link.path);
    };
    return a;
  }
  a.title =
    link.kind === 'plan'
      ? `${link.path}\nClick to open in VSCode · ${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}click to point Beth at it`
      : `${link.path}\nClick to open in VSCode`;
  a.onclick = (e) => {
    e.preventDefault();
    if ((e.metaKey || e.ctrlKey) && link.kind === 'plan') {
      attachRef({ kind: 'item', path: link.path, spoken: link.spoken ?? link.path });
      return;
    }
    openInEditor(link);
  };
  return a;
}

/**
 * Two overlays over one string: proven file references, and the formatting her
 * markdown carried (the server took the markers off — see markdown.ts — so both
 * sets of offsets index the text exactly as it arrives here).
 *
 * They are spliced together as a TREE rather than two passes, because they nest:
 * a path inside a bold clause is one range inside another. Never innerHTML —
 * every node here is built, so nothing she writes can become markup.
 */
const SPAN_TAG = { bold: 'strong', italic: 'em', code: 'code', strike: 's', heading: 'strong' };

function rangeTree(text, links, spans) {
  const ranges = [
    ...(spans ?? []).map((s) => ({ start: s.start, end: s.end, kind: s.kind })),
    ...(links ?? []).map((l) => ({ start: l.start, end: l.end, link: l })),
  ]
    // Outermost first, and a link inside an equal-width span rather than around
    // it — `**plans/foo.md**` should be a bold link, not a link containing bold.
    .sort((a, b) => a.start - b.start || b.end - a.end || (a.link ? 1 : -1));

  const root = { start: 0, end: text.length, children: [] };
  const stack = [root];
  for (const r of ranges) {
    while (stack.length > 1 && r.start >= stack[stack.length - 1].end) stack.pop();
    const parent = stack[stack.length - 1];
    // A range that straddles its parent's edge cannot be nested without breaking
    // one of them. Dropping it loses a bit of styling; splitting it would lose
    // a link. Prefer the readable failure.
    if (r.end > parent.end) continue;
    r.children = [];
    parent.children.push(r);
    stack.push(r);
  }
  return root;
}

function buildRange(node, text) {
  const frag = document.createDocumentFragment();
  let at = node.start;
  for (const c of node.children) {
    if (c.start > at) frag.append(document.createTextNode(text.slice(at, c.start)));
    const n = c.link ? linkNode(c.link) : el(SPAN_TAG[c.kind] ?? 'span', c.kind === 'heading' ? 'heading' : null);
    n.append(buildRange(c, text));
    frag.append(n);
    at = c.end;
  }
  if (at < node.end) frag.append(document.createTextNode(text.slice(at, node.end)));
  return frag;
}

/** Body text with its links and formatting spliced in. */
function bodyWithLinks(text, links, spans) {
  const div = el('div', 'body');
  if (!links?.length && !spans?.length) {
    div.textContent = text;
    return div;
  }
  div.append(buildRange(rangeTree(text, links, spans), text));
  return div;
}

// A faint speaker per paragraph, spoken on demand at ANY level — `off`
// included: a click is an explicit request, not ambience. Extra nodes only;
// the canonical string underneath is untouched (see reread.js).
const withReread = (m) => {
  const body = bodyWithLinks(m.text, m.links, m.spans);
  addRereadButtons(body, m.text, (para) => post('/api/reread', { text: para }));
  return body;
};

const renderAssistant = (m) => entry('assistant', (n) => n.append(withReread(m)));

const renderSay = (m) =>
  entry('say', (n) => {
    n.append(el('span', 'tag', m.kind));
    n.append(withReread(m));
    // The announcement's own ref is already structured — make it the most
    // obvious thing to click.
    if (m.refLink) n.append(linkNode(m.refLink, m.refLink.spoken ?? m.ref));
    else if (m.ref) n.append(el('span', 'ref', m.ref));
  });

// A verb and a subject, not the JSON. The full input is one hover away, because
// the summary is lossy on purpose and the moment you need the arguments you need
// all of them.
const renderActivity = (m) =>
  entry('activity', (n) => {
    n.textContent = `⚙ ${m.summary || `${m.tool} ${m.detail}`}`;
    n.title = `${m.tool} ${m.detail}`;
  });
const renderEvent = (m) =>
  entry('event', (n) => (n.textContent = `${m.event.source} · ${m.event.kind} · ${m.event.text}`));

const askCards = new Map();

function renderAsk(m) {
  // A pending ask arrives TWICE per connect — once in the bus replay, once from
  // the gate's "still waiting" re-send — and a card per copy left a twin that
  // greyed out unanswered when the echo found only the last one. One id, one card.
  if (askCards.has(m.id)) return;
  const card = el('div', 'card');
  const answers = {};
  const blocks = [];
  let remaining = m.questions.length;

  for (const q of m.questions) {
    const block = el('div', 'qblock');
    block.append(el('span', 'hdr', q.header));
    block.append(el('div', 'q', q.question));
    const opts = el('div', 'opts');

    const submit = (value) => {
      if (answers[q.question] !== undefined) return;
      answers[q.question] = value;
      block.append(el('div', 'answer', `→ ${value}`));
      opts.remove();
      free.remove();
      if (--remaining === 0) {
        card.classList.add('answered');
        post('/api/answer', { id: m.id, answers });
      }
    };

    for (const o of q.options) {
      const b = el('button', 'opt');
      b.append(document.createTextNode(o.label));
      b.append(el('span', 'd', o.description));
      b.onclick = () => submit(o.label);
      opts.append(b);
    }
    block.append(opts);

    const free = el('div', 'free');
    const input = el('input');
    input.placeholder = 'or answer in your own words…';
    const go = el('button', 'opt', 'Send');
    go.onclick = () => input.value.trim() && submit(input.value.trim());
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && input.value.trim()) submit(input.value.trim());
    };
    free.append(input, go);
    block.append(free);

    blocks.push({ q, block, opts, free });
    card.append(block);
  }

  // Settled by the bus echo, like the approval cards: a reload replays a
  // resolved ask as a live-looking card, and only the echo carries the answers
  // it never saw clicked. Skips anything already answered locally, so the echo
  // of your own click is a no-op.
  const settle = (given) => {
    for (const { q, block, opts, free } of blocks) {
      if (answers[q.question] !== undefined) continue;
      answers[q.question] = given[q.question] ?? '';
      block.append(el('div', 'answer', `→ ${answers[q.question]}`));
      opts.remove();
      free.remove();
    }
    card.classList.add('answered');
  };

  askCards.set(m.id, { card, settle });
  add(card);
  card.querySelector('input')?.focus();
}

const approvalCards = new Map();

/**
 * Mark a card settled. Driven by the bus echo rather than by the click, so a
 * RELOAD lands in the right state too: the transcript replays the approval, and
 * without this the card comes back looking live and its buttons quietly 404.
 */
function resolveApprovalCard(id, allowed, always) {
  const entry = approvalCards.get(id);
  if (!entry) return;
  approvalCards.delete(id);
  entry.card.classList.add('answered');
  entry.card.append(el('div', 'answer', !allowed ? '→ denied' : always ? '→ allowed, and not asking again' : '→ allowed'));
  entry.opts.remove();
}

function renderApproval(m) {
  const card = el('div', 'card approval');
  card.append(el('span', 'hdr', `permission · ${m.tool}`));
  card.append(el('div', 'q', m.title));
  card.append(el('div', 'body', m.detail));
  const opts = el('div', 'opts');
  approvalCards.set(m.id, { card, opts });
  const decide = (allowed, always) => post('/api/approve', { id: m.id, allowed, always });
  const yes = el('button', 'opt', 'Allow');
  yes.onclick = () => decide(true, false);
  opts.append(yes);
  // Only when the SDK actually gave us a rule that covers this again — a button
  // that silently fails to stop the next identical prompt is worse than no button.
  if (m.canAlways) {
    const always = el('button', 'opt always', 'Always');
    always.title = 'Allow this, and stop asking for it — for this conversation only';
    always.onclick = () => decide(true, true);
    opts.append(always);
  }
  const no = el('button', 'opt', 'Deny');
  no.onclick = () => decide(false, false);
  opts.append(no);
  card.append(opts);
  add(card);
}

/** Decisions opened for answering. Survives the re-render an answer causes. */
const openDecisions = new Set();

/**
 * Cards, kept by decision id across re-renders.
 *
 * ⚠️ This exists because a `pending` message arrives for reasons that have nothing
 * to do with the decisions: a worker starting, a worker finishing, another
 * decision being queued or closed. Rebuilding the list on each one DESTROYED the
 * card being typed into — the field he was halfway through answering was replaced
 * by a fresh empty one, so the focus went and the words with it, seemingly at
 * random and always mid-sentence.
 *
 * Reuse is safe because a queued decision is IMMUTABLE: title, context, options
 * and urgency are set when it is queued and never touched again. The only thing
 * that changes is whether it is still open, and a decision that closes leaves the
 * list entirely.
 */
const decisionNodes = new Map();
/** What was last rendered, so an identical payload touches no DOM at all. */
let decisionSig = '';
let workerSig = '';

/**
 * Put the caret back where it was.
 *
 * Even reusing the same node, `replaceChildren` takes it out of the document and
 * puts it back — and an element that leaves the document loses focus on the way.
 * So the cheap path above (change nothing) is the one that really protects
 * typing; this is what makes the unavoidable rebuilds survivable.
 */
function keepingFocus(within, rebuild) {
  const active = document.activeElement;
  const inside = active && within.contains(active);
  const start = inside ? active.selectionStart : null;
  const end = inside ? active.selectionEnd : null;
  rebuild();
  if (!inside || !active.isConnected) return;
  active.focus();
  if (start !== null && active.setSelectionRange) {
    try {
      active.setSelectionRange(start, end);
    } catch {
      /* not a text field — focus alone is the whole job */
    }
  }
}

/**
 * A queued decision, answerable in one click.
 *
 * It used to be a `window.prompt` pre-filled with the first option, which got
 * the shape exactly backwards: the CONTEXT — the several sentences explaining
 * what is being decided — was visible only inside the dialog, and the OPTIONS,
 * which she went to the trouble of enumerating, were reduced to a default string
 * you had to retype to change. She offers candidate answers because they are the
 * answers; picking one should not require typing it.
 *
 * So: the context is readable in the panel, each option is a button, and the
 * free-text field stays for the answer she did not think of — which is the one
 * that matters most and is exactly what a fixed multiple choice would lose.
 */
function renderDecision(d) {
  const n = el('div', `item urgency-${d.urgency}`);
  const head = el('button', 'dtitle', d.title);
  head.onclick = () => {
    openDecisions.has(d.id) ? openDecisions.delete(d.id) : openDecisions.add(d.id);
    n.classList.toggle('open', openDecisions.has(d.id));
  };
  n.append(head);
  n.append(el('div', 'meta', `${d.urgency}${d.plan ? ` · ${d.plan.split('/').pop()}` : ''}`));

  const body = el('div', 'dbody');
  if (d.context) body.append(el('div', 'dcontext', d.context));
  const answer = (text) => text && post('/api/resolve-decision', { id: d.id, answer: text });
  for (const opt of d.options ?? []) {
    const b = el('button', 'opt', opt);
    b.onclick = () => answer(opt);
    body.append(b);
  }
  const other = el('input', 'dother');
  other.placeholder = d.options?.length ? 'Something else…' : 'Your answer…';
  other.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    answer(other.value.trim());
  };
  body.append(other);
  n.append(body);
  if (openDecisions.has(d.id)) n.classList.add('open');
  return n;
}

/** A worker card — shared by the side panel and the queue overlay. */
function renderWorker(w) {
  const n = el('div', 'item running');
  n.append(el('div', null, w.description));
  const meta = el('div', 'meta', `${w.agentType ?? 'agent'} · started ${new Date(w.startedAt).toLocaleTimeString()}`);
  // A worker that never reported back sits here forever with the dot lit
  // behind it. One click to say "that one is not running".
  const x = el('button', 'dismiss', '×');
  x.title = 'Not running any more — drop it from the roster';
  x.onclick = () => post('/api/close-worker', { taskId: w.taskId });
  meta.append(x);
  n.append(meta);
  return n;
}

function renderPending(m) {
  setSectionCounts(m.decisions.length, m.workers.length);
  decisionsWaiting = m.decisions.length;
  // The overlay renders the same records at full size; keep it in step when it
  // is up, from the same message the panel repaints from.
  lastPending = m;
  if (pendingOverlayOpen) renderPendingOverlay();

  // ⚠️ Only touch the DOM when the LIST changed. Most `pending` messages are about
  // something else entirely — a worker started, a worker finished — and repainting
  // a queue nobody asked to have repainted is how a half-typed answer disappears.
  const dec = $('pending-decisions');
  const sig = m.decisions.map((d) => d.id).join(',');
  if (sig !== decisionSig) {
    decisionSig = sig;
    const live = new Set(m.decisions.map((d) => d.id));
    for (const id of decisionNodes.keys()) if (!live.has(id)) decisionNodes.delete(id);
    keepingFocus(dec, () =>
      dec.replaceChildren(
        ...m.decisions.map((d) => {
          const existing = decisionNodes.get(d.id);
          if (existing) return existing;
          const made = renderDecision(d);
          decisionNodes.set(d.id, made);
          return made;
        })
      )
    );
  }

  const wk = $('pending-workers');
  // Same rule, cheaper: the roster has no field to type in, but it does have a
  // dismiss button, and a rebuild under a click is a click that lands on nothing.
  const wsig = m.workers.map((w) => `${w.taskId}:${w.startedAt}`).join(',');
  if (wsig === workerSig) return;
  workerSig = wsig;
  keepingFocus(wk, () => wk.replaceChildren(...m.workers.map(renderWorker)));
}

// --- shown images and the queue overlay --------------------------------------
//
// Beth's `show` tool puts things on the screen: a figure in the transcript
// (replayed — it is transcript), a pop over the page (not replayed, and sent
// only to the elected speaker tab — "look at this" belongs on the screen Danny
// is looking at), or the pending queue at full size. Both overlays are the
// stats panel's species: bigger glances, not dialogs — Escape and a click off
// the content dismiss them.

const imageUrl = (path) => `/api/image?path=${encodeURIComponent(path)}`;

let lightboxOpen = false;

function openLightbox(path, caption) {
  const img = $('lightbox').querySelector('img');
  img.src = imageUrl(path);
  img.alt = caption || path;
  $('lightbox').querySelector('figcaption').textContent = caption || path;
  $('lightbox').hidden = false;
  lightboxOpen = true;
}

function closeLightbox() {
  $('lightbox').hidden = true;
  // Drop the src so a large image is not kept alive behind a hidden node.
  $('lightbox').querySelector('img').removeAttribute('src');
  lightboxOpen = false;
}
$('lightbox').onclick = closeLightbox;

function renderShow(m) {
  if (m.surface === 'pending') return void openPendingOverlay();
  if (!m.image) return;
  const { path, caption } = m.image;
  entry('show', (n) => {
    const fig = el('figure', 'shown');
    const img = el('img');
    img.src = imageUrl(path);
    img.alt = caption || path;
    img.loading = 'lazy';
    img.title = `${path} — click to view large`;
    img.onclick = () => openLightbox(path, caption);
    // A path the server cannot serve after all (the file left the repo since
    // this replayed) must say so, not render as a mysterious gap.
    img.onerror = () => fig.replaceChildren(el('div', 'meta', `⚠ could not load ${path}`));
    fig.append(img);
    if (caption) fig.append(el('figcaption', null, caption));
    n.append(fig);
  });
  if (m.pop) openLightbox(path, caption);
}

// --- the workbench ---------------------------------------------------------
//
// THE url being iterated on, centre of the header strip. The server owns the
// state (workbench.ts) and vets the url; this only paints what arrives.

/** undefined = nothing painted yet, so the connect-time message lands silently. */
let benchUrl;

function renderBench(m) {
  // Only a genuine change earns a transcript line — the server re-sends the
  // bench on every (re)connect, and "📌 working on…" at each reload is a nag.
  const changed = benchUrl !== undefined && benchUrl !== m.url;
  benchUrl = m.url;
  const box = $('bench');
  if (!m.url) {
    box.hidden = true;
    if (changed) entry('activity', (n) => (n.textContent = '📌 bench cleared'));
    return;
  }
  // The scheme is never the news, so the readable form drops it; the full url
  // stays in the title for when the ellipsis has eaten the interesting half.
  const short = m.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const a = $('bench-link');
  a.href = m.url;
  a.title = `${m.url} — opens in a new tab`;
  const label = $('bench-label');
  label.textContent = m.label ?? '';
  label.hidden = !m.label;
  // With a label the url steps back to a quiet mono aside; without one it IS
  // the bold half.
  const urlEl = $('bench-url');
  urlEl.textContent = short;
  urlEl.className = m.label ? 'quiet' : '';
  box.hidden = false;
  if (changed) entry('activity', (n) => (n.textContent = `📌 working on ${m.label ?? short}`));
}

// The × is Danny's hand on the same state her `workbench` tool sets — the
// broadcast that comes back is what actually hides the pill, in every tab.
$('bench-clear').onclick = () => post('/api/workbench', {});

/**
 * The queue, full size. The side panel's cards squeezed into 34vh are fine to
 * glance at and miserable to WORK: context clipped, options below the fold,
 * scrolling inside a scrolling column. This renders the same immutable records
 * (renderDecision — fresh nodes, the panel's cache keeps its own) with room to
 * read and answer them.
 */
let pendingOverlayOpen = false;
let lastPending = { decisions: [], workers: [] };
/** What the overlay last built, so a worker heartbeat does not rebuild a card mid-answer. */
let overlaySig = null;

function renderPendingOverlay() {
  const sig = `${lastPending.decisions.map((d) => d.id).join(',')}|${lastPending.workers.map((w) => w.taskId).join(',')}`;
  if (sig === overlaySig) return;
  overlaySig = sig;
  const sheet = $('pending-sheet');
  keepingFocus(sheet, () => {
    const kids = [el('h2', null, 'Pending')];
    if (!lastPending.decisions.length) kids.push(el('div', 'meta', 'Nothing waiting.'));
    for (const d of lastPending.decisions) {
      const n = renderDecision(d);
      n.classList.add('open'); // full size is the point — no second unfold
      kids.push(n);
    }
    if (lastPending.workers.length) {
      kids.push(el('h2', null, 'Workers'));
      for (const w of lastPending.workers) kids.push(renderWorker(w));
    }
    sheet.replaceChildren(...kids);
  });
}

function openPendingOverlay() {
  overlaySig = null;
  renderPendingOverlay();
  $('pending-overlay').hidden = false;
  pendingOverlayOpen = true;
}

function closePendingOverlay() {
  $('pending-overlay').hidden = true;
  pendingOverlayOpen = false;
  overlaySig = null;
}
$('pending-overlay').onclick = (e) => {
  if (!e.target.closest('.sheet')) closePendingOverlay();
};
$('pending-expand').onclick = (e) => {
  // Inside the heading, whose click is the collapse toggle — this is not that.
  e.stopPropagation();
  openPendingOverlay();
};

// --- plans panel + click-to-reference ---------------------------------------
//
// Clicking is the point of this panel. A reference is a PAIR — the spoken name
// Beth reads back, and the path she resolves — so a click carries both, and the
// composer shows the name while the path rides underneath.

/** Pending references for the next turn, in click order. */
let refs = [];
/** Expansion survives re-render; the index republishes on every file save. */
const expanded = new Set();
/**
 * Umbrellas folded shut, by path. Persisted, because a tree you keep having to
 * re-collapse is worse than no tree — and the index republishes on every file
 * save, so in-memory state alone would not even survive someone else's commit.
 */
const COLLAPSED_KEY = 'harness.collapsedUmbrellas';
const collapsedParents = new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'));
const rememberCollapsed = () => localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedParents]));
const collapsedGroups = new Set(['blocked', 'planning']);
// `awaiting-eyes` is deliberately absent: it opens by default, always.
let workItems = [];

const refKey = (r) => `${r.path}#${r.taskIndex ?? ''}`;

/**
 * Mirror the chips to the server. A SPOKEN turn never passes through this page —
 * ElevenLabs dials the harness directly — so pointing has to live server-side or
 * clicking a plan and then talking loses the reference.
 */
// Seeded from the clock so a page reload always outranks the previous page's
// updates — a plain counter restarting at 0 would be rejected as stale.
let pointSeq = Date.now();
const syncRefs = () => post('/api/point', { refs, seq: ++pointSeq });

function renderRefs() {
  const box = $('composer-refs');
  box.hidden = refs.length === 0;
  box.replaceChildren(
    ...refs.map((r) => {
      const chip = el('span', `chip ${r.kind}`);
      chip.append(el('span', 'chip-name', r.spoken));
      chip.title = r.line ? `${r.path}:${r.line}` : r.path;
      const x = el('button', 'chip-x', '×');
      x.title = 'Remove this reference';
      x.onclick = () => {
        refs = refs.filter((o) => refKey(o) !== refKey(r));
        renderRefs();
        syncRefs();
      };
      chip.append(x);
      return chip;
    })
  );
}

function attachRef(ref) {
  if (!refs.some((r) => refKey(r) === refKey(ref))) refs.push(ref);
  renderRefs();
  syncRefs();
  input.focus();
}

/** Task progress, or null when the plan has no checkboxes. Never "0%". */
const taskSummary = (item) =>
  item.tasks.length ? { done: item.tasks.filter((t) => t.done).length, total: item.tasks.length } : null;

function renderTask(item, task) {
  const row = el('div', `task ${task.done ? 'done' : ''}`);
  row.style.paddingLeft = `${8 + task.depth * 10}px`;
  row.append(el('span', 'box', task.done ? '☑' : '☐'));
  row.append(el('span', 'task-text', task.text));
  row.title = `Point Beth at this task — ${item.path}:${task.line}`;
  row.onclick = () =>
    attachRef({ kind: 'task', path: item.path, spoken: task.spoken, taskIndex: task.index, line: task.line });
  return row;
}

function renderWorkItem(item, depth = 0, orphanParent = null, childCount = 0) {
  const n = el('div', `item work-item status-${item.status}`);
  if (depth) n.style.marginLeft = `${depth * 11}px`;
  const head = el('div', 'work-head');

  const t = taskSummary(item);
  const folded = collapsedParents.has(item.path);

  // The caret means STRUCTURE wherever there is structure: folding an umbrella
  // is the more valuable move, and one plan (beadgame's Player UI umbrella) has
  // both children and tasks, so they cannot share a control. Tasks stay reachable
  // from the count in the meta line, which works the same way on every row.
  if (childCount) {
    const caret = el('button', 'caret', folded ? '▸' : '▾');
    caret.title = folded ? `Show the ${childCount} plans under this` : `Fold this umbrella (${childCount} under)`;
    caret.onclick = (e) => {
      e.stopPropagation();
      folded ? collapsedParents.delete(item.path) : collapsedParents.add(item.path);
      rememberCollapsed();
      renderWork();
    };
    head.append(caret);
  } else if (t) {
    const caret = el('button', 'caret', expanded.has(item.path) ? '▾' : '▸');
    caret.title = 'Show tasks';
    caret.onclick = (e) => {
      e.stopPropagation();
      expanded.has(item.path) ? expanded.delete(item.path) : expanded.add(item.path);
      renderWork();
    };
    head.append(caret);
  } else {
    head.append(el('span', 'caret spacer', ' '));
  }

  const name = el('button', 'work-name', item.spoken);
  name.title = `Point Beth at this plan — ${item.path}`;
  name.onclick = () => attachRef({ kind: 'item', path: item.path, spoken: item.spoken });
  head.append(name);

  // The shelf. A pin is an ADDITIONAL place to find a plan, never a move, so this
  // row keeps its place in the status tree either way.
  const isPinned = pinnedPaths.has(item.path);
  const pin = el('button', `pin${isPinned ? ' on' : ''}`, isPinned ? '★' : '☆');
  pin.title = isPinned ? 'Unpin' : 'Pin to the top of the panel';
  pin.onclick = (e) => {
    e.stopPropagation();
    post('/api/pin', { path: item.path, pinned: !isPinned });
  };
  head.append(pin);

  // Rename. The spoken name is what Beth calls this plan out loud, and a derived
  // one is sometimes wrong in a way only Danny can hear — so it is correctable
  // from the surface where he notices it. ⚠ This WRITES to the plan file (the one
  // place the harness does); see planName.ts.
  const rename = el('button', 'rename', '✎');
  rename.title = `Rename "${item.spoken}" — writes name: into the plan's frontmatter`;
  rename.onclick = async (e) => {
    e.stopPropagation();
    const next = prompt(`Spoken name for this plan\n${item.path}`, item.name ?? item.spoken);
    if (next === null || !next.trim() || next.trim() === item.spoken) return;
    const res = await post('/api/rename', { path: item.path, name: next.trim() });
    const bodyJson = await res.json().catch(() => ({}));
    // The panel repaints from the file watcher, not from here — so a silent
    // failure would look exactly like a rename that did not take.
    if (!res.ok) alert(`Could not rename\n\n${bodyJson.reason ?? res.status}`);
  };
  head.append(rename);

  // Read it where it is reviewable. Only drawn when the repo HAS a github origin
  // — the hello says so — and the href is our own endpoint rather than a github
  // URL, because the branch is resolved at the moment of the click. See
  // repoWeb.ts for why that matters more than it sounds like it does.
  if (repoOnWeb) {
    const gh = el('a', 'gh', '↗');
    gh.href = `/api/github?path=${encodeURIComponent(item.path)}`;
    gh.target = '_blank';
    gh.rel = 'noreferrer';
    gh.title = `Open "${item.spoken}" on GitHub`;
    gh.onclick = (e) => e.stopPropagation();
    head.append(gh);
  }

  // Hand off to a fresh interactive Claude Code session. Disabled outright on a
  // live claim — one implementer at a time, and the server refuses too.
  const hand = el('button', 'handoff', '⌘');
  hand.textContent = '›_';
  hand.title = item.claim?.live
    ? `Claimed by a live session (${item.claim.owner}) — hand off is blocked`
    : `Open a Claude Code session on "${item.spoken}"`;
  if (item.claim?.live) hand.classList.add('blocked');
  hand.onclick = async (e) => {
    e.stopPropagation();
    const res = await post('/api/handoff', { path: item.path });
    const body = await res.json();
    if (!res.ok) {
      hand.classList.add('blocked');
      hand.title = body.reason ?? 'refused';
      alert(`Handoff refused\n\n${body.reason}`);
    }
  };
  head.append(hand);
  n.append(head);

  const meta = el('div', 'meta');
  if (item.priority) meta.append(document.createTextNode(`${item.priority} · `));
  if (t) {
    // Clickable everywhere, so opening tasks does not depend on whether this row
    // happens to be an umbrella.
    const count = el('button', 'task-toggle', `${t.done}/${t.total} tasks`);
    count.title = expanded.has(item.path) ? 'Hide tasks' : 'Show tasks';
    count.onclick = (e) => {
      e.stopPropagation();
      expanded.has(item.path) ? expanded.delete(item.path) : expanded.add(item.path);
      renderWork();
    };
    meta.append(count);
  } else {
    meta.append(document.createTextNode('no tasks'));
  }
  // A folded umbrella must still account for what it is hiding.
  if (childCount) meta.append(document.createTextNode(` · ${childCount} under`));
  // A live claim means an implementer is on it — the thing a handoff must respect.
  if (item.claim?.live) meta.append(document.createTextNode(' · claimed'));
  else if (item.claim) meta.append(document.createTextNode(' · stale owner'));
  n.append(meta);

  if (t) {
    const bar = el('div', 'bar');
    const fill = el('div', 'fill');
    fill.style.width = `${Math.round((t.done / t.total) * 100)}%`;
    bar.append(fill);
    n.append(bar);
  }

  // A child whose umbrella sits in ANOTHER status group cannot be nested under
  // it without breaking status-first ordering — and status-first is what keeps
  // awaiting-eyes at the top. So it stays in its own group and carries the
  // umbrella as a breadcrumb instead of losing the context entirely.
  if (orphanParent) {
    const bc = el('div', 'umbrella-of', `↳ ${orphanParent.spoken}`);
    bc.title = `Under the umbrella "${orphanParent.spoken}" (${orphanParent.status})`;
    n.append(bc);
  }

  if (expanded.has(item.path)) {
    const list = el('div', 'tasks');
    for (const task of item.tasks) list.append(renderTask(item, task));
    n.append(list);
  }
  return n;
}

// awaiting-eyes leads: it is the one pile only Danny can clear, and burying it
// under thirty active plans is what hid the batched-confirmation queue entirely.
// Then work in progress, then everything else in roughly lifecycle order.
const LIVE_ORDER = ['awaiting-eyes', 'active', 'blocked', 'planning'];
const ALL_ORDER = [...LIVE_ORDER, 'idea', 'review', 'unknown', 'parked', 'shipped'];

/** 'in-flight' (the default) or 'all'. The panel is a work surface, not an archive. */
let workScope = 'in-flight';
let workTotal = 0;
/** Danny's shelf, resolved server-side and persisted across restarts. See pins.ts. */
let pinnedItems = [];
let pinnedPaths = new Set();
/** path → item, for resolving a parent that lives in a different group. */
let byPathAll = new Map();

function renderWork() {
  const panel = $('work-panel');
  byPathAll = new Map(workItems.map((i) => [i.path, i]));
  // Say what is being shown AND what exists — "69" alone reads as the total.
  // "69" alone reads as the total. "69 of 571" says what is shown and what exists,
  // and still fits the 300px panel on one line.
  $('work-count').textContent = workTotal
    ? workScope === 'all'
      ? `all ${workItems.length}`
      : `${workItems.length} of ${workTotal}`
    : '';
  $('work-count').title =
    workScope === 'all'
      ? 'Every plan in the repo.'
      : `${workItems.length} plans are in flight (active, blocked or planning). ${workTotal} exist in total — the rest are shipped, parked or ideas.`;
  $('work-scope').textContent = workScope === 'all' ? 'in flight only' : 'show all';
  panel.replaceChildren();

  // The shelf, above everything. Flat and in pin order: it is HIS ordering laid
  // over the index's, so grouping or nesting it by status would be the panel
  // taking the ordering back. Every row here also appears in its status group
  // below — the pin is a second place to find a plan, not a move.
  if (pinnedItems.length) {
    const open = !collapsedGroups.has('pinned');
    const hdr = el('button', 'group-head');
    hdr.append(el('span', 'caret', open ? '▾' : '▸'));
    hdr.append(el('span', 'group-name', 'pinned'));
    hdr.append(el('span', 'group-count', String(pinnedItems.length)));
    hdr.onclick = () => {
      open ? collapsedGroups.add('pinned') : collapsedGroups.delete('pinned');
      renderWork();
    };
    panel.append(hdr);
    if (open) for (const item of pinnedItems) panel.append(renderWorkItem(item, 0, null, 0));
  }

  for (const status of workScope === 'all' ? ALL_ORDER : LIVE_ORDER) {
    const group = workItems.filter((i) => i.status === status);
    if (!group.length) continue;
    const open = !collapsedGroups.has(status);

    const hdr = el('button', 'group-head');
    hdr.append(el('span', 'caret', open ? '▾' : '▸'));
    hdr.append(el('span', 'group-name', status));
    hdr.append(el('span', 'group-count', String(group.length)));
    hdr.onclick = () => {
      open ? collapsedGroups.add(status) : collapsedGroups.delete(status);
      renderWork();
    };
    panel.append(hdr);

    if (open) {
      // Nest within the group: an umbrella and its children render as a tree when
      // they share a status, which is the common case (umbrellas are active and
      // so is most of what hangs off them).
      const inGroup = new Set(group.map((i) => i.path));
      const kids = new Map();
      for (const i of group) {
        if (!i.parent || !inGroup.has(i.parent)) continue;
        (kids.get(i.parent) ?? kids.set(i.parent, []).get(i.parent)).push(i);
      }
      // How many rows a fold actually hides — the whole subtree, not one level.
      // "2 under" while swallowing eleven plans is a worse lie than no number.
      const descendants = (p) => (kids.get(p) ?? []).reduce((n, k) => n + 1 + descendants(k.path), 0);
      const emit = (item, depth) => {
        const mine = kids.get(item.path) ?? [];
        const parentElsewhere = item.parent && !inGroup.has(item.parent) ? byPathAll.get(item.parent) : null;
        panel.append(renderWorkItem(item, depth, depth === 0 ? parentElsewhere : null, descendants(item.path)));
        if (collapsedParents.has(item.path)) return; // fold the whole subtree, not one level
        for (const k of mine) emit(k, depth + 1);
      };
      for (const item of group) if (!item.parent || !inGroup.has(item.parent)) emit(item, 0);
    }
  }
}

/**
 * The last usage snapshot, kept rather than printed.
 *
 * This used to be a run-on sentence of numbers across the top right — the most
 * valuable strip on the page spent on a question nobody asks mid-conversation.
 * It is all still here, one click away, and the strip is free for something you
 * actually glance at.
 */
let lastUsage = null;

function renderUsage(u) {
  lastUsage = u;
  if (statsOpen) renderStats();
}

function feedEvent(e) {
  const feed = $('event-feed');
  const n = el('div', 'item');
  n.append(el('div', null, e.text));
  n.append(el('div', 'meta', `${e.kind} · ${new Date(e.ts).toLocaleTimeString()}`));
  feed.prepend(n);
  while (feed.children.length > 20) feed.lastChild.remove();
}

// --- stream ----------------------------------------------------------------

const handlers = {
  hello: (m) => {
    repoPath = m.repo;
    repoOnWeb = Boolean(m.repoOnWeb);
    setPersonas(m.personas ?? [], m.persona ?? '');
    void loadVoices();
    projectName = m.repo.split('/').pop();
    $('repo-label').textContent = projectName;
    // Several instances run side by side, one per repo — the tab title is the
    // only way to tell them apart from the window switcher. The name comes from
    // the bound repo, so a different project's director is called what it calls
    // her rather than what this harness assumes. Status rides in front of it —
    // see paintTitle.
    titleBase = `${m.director ?? 'Director'}: ${projectName}`;
    paintTitle();
    setDirectorName(m.director);
    const mode = $('mode-label');
    mode.textContent = m.mode;
    mode.className = `mode ${m.mode}`;
    mode.title = m.modeReason;
    if (m.model) $('model-select').value = m.model;
    if (m.permissionMode) setPermissionMode(m.permissionMode);
    if (m.speechLevel) setSpeechLevel(m.speechLevel);
    setEffortLevel(m.effort ?? '');
    myStreamId = m.streamId;
    // A page that reconnects while focused should get the mouth back.
    if (document.hasFocus()) claimVoice();
    buildVoice(m);
  },
  model: (m) => {
    $('model-select').value = m.model;
  },
  permission: (m) => {
    setPermissionMode(m.mode);
    entry('activity', (n) => (n.textContent = `🔑 permissions → ${m.mode}`));
  },
  speech: (m) => {
    setSpeechLevel(m.level);
    entry('activity', (n) => (n.textContent = `🔈 speech → ${m.level}`));
    // Silent means NOW, not "after she finishes the paragraph". Same stop as a
    // barge-in: pause the line in flight, drop the backlog. The dropped lines
    // are a real saving, not just quiet — a queued line is only an id until it
    // plays, and ElevenLabs bills at the fetch — while the line mid-play is
    // already paid for either way. Handled on the broadcast rather than the
    // click so her own `speech` tool call mutes exactly like the dropdown.
    if (m.level === 'off') spk.stop();
  },
  effort: (m) => {
    setEffortLevel(m.level);
    entry('activity', (n) => (n.textContent = `🧠 effort → ${m.level || 'default'}`));
  },
  persona: (m) => {
    $('persona-select').value = m.slug;
    current.persona = m.slug;
    // The name is not decoration — it is what the composer invites you to talk
    // to and what a permission card says. It arrives with the switch so the page
    // never has to guess it from a slug.
    setDirectorName(m.name);
    // The tab is named after her too, and it used to keep yesterday's director
    // until a reload — the one surface setDirectorName didn't reach.
    if (projectName) {
      titleBase = `${m.name}: ${projectName}`;
      paintTitle();
    }
    entry('activity', (n) => (n.textContent = `🎭 director → ${m.name}`));
  },
  // The turn was sent — the preview has become a real message in the transcript.
  user: (m) => {
    clearInterim();
    renderUser(m);
  },
  assistant: (m) => {
    renderAssistant(m);
  },
  say: (m) => {
    renderSay(m);
    feedEvent({ ts: new Date().toISOString(), kind: `say/${m.kind}`, text: m.text });
  },
  show: renderShow,
  workbench: renderBench,
  // Tool calls are the conversation still moving. Without this, a long stretch
  // of work emits nothing the idle timer recognises, the paid session closes
  // mid-job, and the result Danny actually wanted to hear arrives to a shut
  // channel — the exact reason a successful ship ended in silence.
  activity: (m) => {
    renderActivity(m);
  },
  ask: renderAsk,
  ask_resolved: (m) => askCards.get(m.id)?.settle(m.answers ?? {}),
  approval: renderApproval,
  approval_resolved: (m) => resolveApprovalCard(m.id, m.allowed, m.always),
  usage: (m) => {
    renderUsage(m.usage);
    ctxPct = m.usage.contextPct;
    paintProgress();
  },
  status: (m) => {
    turnInFlight = m.state === 'thinking';
    statusState = m.state;
    setBusy();
    // A deliberate stop is not a failure — mark it quietly.
    if (m.detail === 'stopped') entry('activity', (n) => (n.textContent = '⏹ stopped'));
    else if (m.state === 'error' && m.detail) entry('error', (n) => (n.textContent = `⚠ ${m.detail}`));
  },
  pending: (m) => {
    renderPending(m);
    // The stream carries RUNNING workers only, so this is a count of live work.
    workersRunning = m.workers.length;
    setBusy();
  },
  work: (m) => {
    workTotal = m.total ?? m.items.length;
    // The shelf is resolved server-side and arrives whatever the scope — a pinned
    // plan is frequently parked or shipped, so it is not in `items` at all.
    pinnedItems = m.pinned ?? [];
    pinnedPaths = new Set(pinnedItems.map((i) => i.path));
    // The stream only carries the in-flight slice; in 'all' mode re-pull so the
    // panel still reflects a file that just changed.
    if (workScope === 'all') return void loadAllWork();
    workItems = m.items;
    renderWork();
  },
  // A spoken turn consumed the references — drop the chips it used.
  pointing: (m) => {
    refs = m.refs ?? [];
    renderRefs();
  },
  cleared: () => {
    transcript.replaceChildren();
    askCards.clear();
    approvalCards.clear();
    lastUsage = null;
    entry('activity', (n) => (n.textContent = '— new conversation —'));
  },
  voice: (m) => {
    // 'hearing' is a transcript revision — he is mid-sentence. Anything else
    // means that utterance is over, one way or another.
    if (m.state === 'hearing') showInterim(m.detail ?? '');
    else if (m.state === 'ignored' || m.state === 'duplicate' || m.state === 'disconnected') clearInterim();
    // Something she wrote was never said. It is in the transcript, so the only
    // thing he cannot otherwise know is that he never heard it — and silence is
    // indistinguishable from a hang, which is the whole reason this is loud.
    if (m.state === 'unspoken') {
      entry('activity', (n) => (n.textContent = `🔇 not spoken — ${m.detail ?? 'no channel was open'}`));
    }
    renderVoice(m.status, m.detail);
  },
  speak: (m) => spk.enqueue(m.id),
  room: (m) => applyRoom(m),
  // The Scribe ear's frames — partials, commits, a steal, a degrade. RemoteEar
  // filters by owner and translates into the same composer callbacks the
  // browser ear uses; a page running listen.js has no onEar and ignores these.
  ear: (m) => voice?.onEar?.(m),
  tests: (m) => renderTests(m.state),
  event: (m) => {
    renderEvent(m);
    feedEvent(m.event);
  },
};

// --- her voice, outbound ------------------------------------------------------
//
// Playback lives in speaker.js (a module for the same reason listen.js is one:
// the bookkeeping is testable when node can stub the <audio>). What stays here
// is what belongs to the PAGE: which tab owns the mouth, and the mirror of the
// machine's voice room.

/**
 * The MACHINE's voice room — one mute and one volume across every harness on
 * this Mac, because three beths speaking are one soundscape and their voices
 * are similar in loudness. The store is server-side (~/.director-harness, see
 * src/voiceRoom.ts); this is only the mirror the controls read, updated by
 * `room` messages — including ones another beth's tab caused.
 *
 * ⚠️ Volume zero is mute-by-loudness, not silence: the line still fetches and
 * still BILLS. The mute button is the one that stops billing, because it gates
 * lines server-side before they are ever announced.
 */
let roomState = { muted: false, volume: 1 };

const spk = createSpeaker({
  audio: new Audio(),
  park: () => voice?.park?.(),
  unpark: () => voice?.unpark?.(),
  note: (text) => entry('activity', (n) => (n.textContent = text)),
  // Every way a line ends is reported — the release half of the machine's
  // talking stick. Fire-and-forget: a lost report is what the backstop is for.
  report: (ids) => post('/api/voice/done', { ids }),
  // The real volume arrives in the `room` message, which the server sends
  // before the replay — and `speak` never replays, so nothing can play first.
  initialVolume: 1,
});

function applyRoom(m) {
  const wasMuted = roomState.muted;
  roomState = { muted: m.muted, volume: m.volume };
  spk.setVolume(m.volume);
  // "Everybody, right now": the server-side gate only stops NEW lines from
  // being announced, so going muted also cuts the line already playing.
  if (m.muted && !wasMuted) spk.stop();
  const mute = $('mute-toggle');
  mute.classList.toggle('on', m.muted);
  mute.title = m.muted
    ? 'Muted — every director on this machine. Click to unmute.'
    : 'Mute every director on this machine — nothing plays, nothing is billed';
  const slider = $('volume-slider');
  // Not while he is dragging it: the echo of his own drag arriving a beat late
  // would yank the thumb out from under the pointer.
  if (document.activeElement !== slider) slider.value = String(Math.round(m.volume * 100));
}

/**
 * ONE MOUTH, however many tabs are open.
 *
 * Voice used to be a machine singleton, so two pages could not both speak. Now
 * every page can play audio, and two tabs meant hearing her twice, slightly out
 * of phase, on top of herself. The server elects one speaker; this claims it for
 * whichever tab you are actually looking at.
 */
let myStreamId = 0;
const claimVoice = () => myStreamId && post('/api/voice/claim', { streamId: myStreamId });
window.addEventListener('focus', claimVoice);
document.addEventListener('visibilitychange', () => !document.hidden && claimVoice());

// --- in-progress indicator -------------------------------------------------
//
// A turn with no outward sign is indistinguishable from a hang — the same
// problem her spoken narration solves for the ear. Tracks a turn in flight AND
// background workers, because "nothing is happening" and "a worker is building
// images" look identical from the composer otherwise.
//
// Two indicators, two scopes, and they must not answer the same question:
//   - the DOT (top left) — is anything running FOR her: a turn, a worker, or a
//     decision queued against you. It is the glance from across the room.
//   - the SPINNER (composer) — is she thinking RIGHT NOW. It sits by the input
//     because that is where you are when deciding whether to keep typing.
// The timer beside the spinner keeps counting the composite state, so a worker
// grinding alone still shows its clock and its count.

let turnInFlight = false;
let workersRunning = 0;
let decisionsWaiting = 0;
/** The server's own view: idle | thinking | error. Only 'error' outranks ours. */
let statusState = 'idle';
/** What the tab is called with no status on it. 'beth' until `hello` names it. */
let titleBase = document.title;
let projectName = '';
let dotTitle = '';
let busySince = 0;
let busyTick = null;
let ctxPct = 0;

const mmss = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function paintDot() {
  const dot = $('status-dot');
  const reasons = [];
  if (turnInFlight) reasons.push('thinking');
  if (workersRunning) reasons.push(`${workersRunning} worker${workersRunning > 1 ? 's' : ''}`);
  if (decisionsWaiting) reasons.push(`${decisionsWaiting} waiting on you`);
  const err = statusState === 'error';
  dot.className = `dot ${err ? 'error' : reasons.length ? 'busy' : 'idle'}`;
  dot.title = (err ? dotTitle : reasons.join(' · ') || 'idle') + ' — click for the wire';
  // Every state the dot paints funnels through here, so the tab follows for free.
  paintTitle();
}

/**
 * The tab strip is the page when the page is hidden — and with one instance per
 * repo it is also the switchboard, so each tab answers "is anything waiting on
 * me over there" without being visited. The same state as the dot, front-loaded
 * because truncation eats the back: decisions waiting on Danny first (the
 * browser-tab convention for "unread, yours"), then the running dot, ⚠ instead
 * when the server reports an error.
 *
 * The mic is deliberately NOT here: Chrome paints its own recording badge on
 * any tab holding the mic, hidden or not, and a title glyph would be a copy of
 * an indicator the page cannot fake — trust the browser's.
 */
function paintTitle() {
  const badge =
    (decisionsWaiting ? `(${decisionsWaiting}) ` : '') +
    (statusState === 'error' ? '⚠ ' : turnInFlight || workersRunning ? '● ' : '');
  const t = badge + titleBase;
  // paintDot runs on the busy clock's every tick — only touch the tab on change.
  if (document.title !== t) document.title = t;
}

// --- the wire panel ----------------------------------------------------------
//
// Lives in wire.js — self-contained by design, pull-only, math tested in node.
// The dot answers "is anything running"; clicking it opens the anatomy of
// exactly that.

const wirePanel = createWirePanel({ box: $('wire-panel'), el, isTurnInFlight: () => turnInFlight });
$('status-dot').onclick = wirePanel.toggle;

function paintProgress() {
  const busy = turnInFlight || workersRunning > 0;
  paintDot();
  paintMeter();
  $('progress').hidden = !busy;
  // The spinner is the PREDICTION, not the work: a worker running on its own
  // leaves the timer and its count, and stops claiming she is mid-sentence.
  $('progress-spin').hidden = !turnInFlight;
  if (!busy) return;
  $('progress-time').textContent = mmss(Date.now() - busySince);
  $('progress-note').textContent = workersRunning
    ? `${workersRunning} worker${workersRunning > 1 ? 's' : ''}`
    : '';
}

/**
 * The context meter is always on, because it is a GAUGE. It answers "how much
 * room is left", which is as true between turns as during one — hiding it while
 * idle meant the only time you could see it was the time you were watching
 * something else.
 */
function paintMeter() {
  const ctx = $('ctx-meter');
  ctx.firstElementChild.style.setProperty('--fill', `${Math.min(100, ctxPct)}%`);
  ctx.className = `ctx${ctxPct >= 85 ? ' hot' : ctxPct >= 60 ? ' warm' : ''}`;
  ctx.title = `Context ${ctxPct.toFixed(1)}% used — click for the numbers`;
  if (statsOpen) renderStats();
}

// --- is the tree green -------------------------------------------------------
//
// A light and a count in the top right, and the log behind a click. The gesture
// that matters is the last one: clicking a FAILURE drops a chip in the composer
// rather than pasting a wall of stack trace, which is the same unlock deixis was
// for plans — she gets "the settle-window test in listen.test.ts" as something
// she can say out loud, with the file, the line and the assertion underneath.

let testState = null;
let testPanelOpen = false;

function renderTests(state) {
  testState = state;
  const btn = $('test-light');
  btn.className = `tlight ${state.light}`;
  const n = state.last?.failures.length ?? 0;
  $('test-count').textContent = state.light === 'red' ? (n || '!') : '';
  btn.title = !state.command
    ? 'No test runner detected — set HARNESS_TEST_CMD'
    : !state.enabled
      ? `Tests not enabled here — click to see ${state.command.join(' ')}`
      : state.running
        ? 'Running…'
        : !state.last
          ? 'No run yet'
          : state.last.timedOut
            ? 'Timed out'
            : (state.last.exitCode ?? 1) !== 0
              ? `${n || 'some'} failing${state.stale ? ' — and the tree has changed since' : ''}`
              : state.stale
                ? 'Passed, but the tree has changed since'
                : 'Green';
  if (testPanelOpen) renderTestPanel();
}

function renderTestPanel() {
  const box = $('test-panel');
  box.replaceChildren();
  const s = testState;
  if (!s) return;

  if (!s.command) {
    box.append(el('h3', null, 'Tests'));
    box.append(el('div', 'snote', 'No runner detected here. Set HARNESS_TEST_CMD in the repo’s .env to name one.'));
    return;
  }

  box.append(el('h3', null, 'Tests'));
  const cmd = el('div', 'tcmd', s.command.join(' '));
  cmd.title = `detected from ${s.why}`;
  box.append(cmd);

  // ⚠️ The command is shown BEFORE the switch is offered. This runs project code
  // on a schedule, and a suite that spins containers or costs money must not
  // start because you happened to save a file.
  const toggle = el('button', 'topt', s.enabled ? 'Stop watching' : 'Watch this repo');
  toggle.onclick = () => post('/api/tests/enable', { on: !s.enabled });
  box.append(toggle);
  const now = el('button', 'topt ghost', 'Run now');
  now.onclick = () => post('/api/tests/run');
  box.append(now);

  if (!s.enabled) {
    box.append(el('div', 'snote', 'Off here. Enabling runs this command whenever the tree changes, settles, and she is idle.'));
  }

  const r = s.last;
  if (!r) return void (s.enabled && box.append(el('div', 'snote', 'no run yet')));

  box.append(el('h3', null, 'Last run'));
  const when = new Date(r.at).toLocaleTimeString();
  box.append(
    el(
      'div',
      'snote',
      `${when} · ${(r.ms / 1000).toFixed(1)}s · ${r.timedOut ? 'TIMED OUT' : `exit ${r.exitCode}`}${s.stale ? ' · tree changed since' : ''}`
    )
  );

  if (r.failures.length) {
    box.append(el('h3', null, `Failures (${r.failures.length})`));
    for (const f of r.failures) {
      const row = el('button', 'tfail');
      row.append(el('div', 'tname', f.spoken));
      if (f.path) row.append(el('div', 'tloc', `${f.path}${f.line ? `:${f.line}` : ''}`));
      if (f.detail) row.append(el('div', 'tdetail', f.detail));
      // Same machinery as a plan: a reference PAIR, so she gets a name she can
      // say and the location underneath — not a paragraph of stack trace.
      row.onclick = () => {
        attachRef({ kind: 'test', path: f.path ?? '', spoken: f.spoken, line: f.line, detail: f.detail });
        toggleTestPanel();
      };
      box.append(row);
    }
  }

  if (r.output.trim()) {
    box.append(el('h3', null, 'Output'));
    // Whatever the parsers could not read is still here, which is always better
    // than nothing — and the TAIL is what matters when a suite fails late.
    box.append(el('pre', 'tlog', r.output.slice(-8000)));
  }
}

function toggleTestPanel() {
  testPanelOpen = !testPanelOpen;
  $('test-panel').hidden = !testPanelOpen;
  $('test-light').classList.toggle('open', testPanelOpen);
  if (testPanelOpen) renderTestPanel();
}

// --- the numbers, behind the meter ------------------------------------------
//
// Two sources, and they fail independently on purpose. The LOCAL numbers (context,
// this turn, this session) come off the bus and are always right. The PLAN windows
// come from an SDK method whose name is a warning — `usage_EXPERIMENTAL_MAY_CHANGE
// _DO_NOT_RELY_ON_THIS_API_YET` — so they are fetched separately, and their absence
// is rendered as a line rather than as a broken panel.

let statsOpen = false;
let planLimits = null;

// A million-token window is now ordinary, and "1000.0k" reads as a bug.
const kfmt = (n) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(Math.round(n));

/** "in 3h", "Fri 09:00" — a reset is only useful as a distance. */
function untilWhen(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'now';
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)}m`;
  if (h < 24) return `${Math.round(h)}h`;
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short' });
}

function bar(pct) {
  const wrap = el('span', `sbar${pct >= 85 ? ' hot' : pct >= 60 ? ' warm' : ''}`);
  const fill = el('i');
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  wrap.append(fill);
  return wrap;
}

function statRow(label, value, pct) {
  const row = el('div', 'srow');
  row.append(el('span', 'sk', label));
  if (pct !== undefined) row.append(bar(pct));
  row.append(el('span', 'sv', value));
  return row;
}

function renderStats() {
  const box = $('stats');
  box.replaceChildren();
  const u = lastUsage;

  box.append(el('h3', null, 'Context'));
  box.append(
    statRow(
      `${ctxPct.toFixed(1)}%`,
      u ? `${kfmt(u.contextTokens)} / ${kfmt(u.contextMax)}` : 'no turn yet',
      ctxPct
    )
  );

  if (u) {
    box.append(el('h3', null, 'This turn'));
    box.append(statRow('in', kfmt(u.turnInput)));
    box.append(statRow('cached', kfmt(u.turnCached)));
    box.append(statRow('out', kfmt(u.turnOutput)));
    box.append(statRow('cost', `$${u.turnCost.toFixed(4)}`));

    box.append(el('h3', null, 'Session'));
    box.append(statRow('cost', `$${u.totalCost.toFixed(4)}`));
    box.append(statRow('model', u.model));
  }

  // The other bill. Characters are exact — the harness sent them — but the
  // dollars are an estimate, so the rate behind them is printed rather than
  // hidden: a number you can check beats a number you have to trust.
  // The volume moved to the strip when it became the MACHINE's dial rather
  // than this page's — a control was always a stranger in a panel of readouts.
  const s = planLimits?.speech;
  box.append(el('h3', null, 'Speech'));
  if (!planLimits) box.append(el('div', 'snote', 'checking…'));
  else if (!s) box.append(el('div', 'snote', 'not reported'));
  else if (!s.available) box.append(el('div', 'snote', 'text-only — nothing spoken'));
  else if (!s.lines) box.append(el('div', 'snote', 'nothing spoken yet'));
  else {
    box.append(statRow('lines', String(s.lines)));
    box.append(statRow('chars', kfmt(s.chars)));
    box.append(statRow('cost', `≈$${s.usd.toFixed(4)}`));
    // The vendor prefix is on every model and costs a line of wrap in a narrow
    // panel; what varies is the part after it.
    box.append(
      el(
        'div',
        'snote',
        `${s.model.replace(/^eleven_/, '')} · ${s.creditsPerChar} cr/char · $${s.usdPer1kCredits}/1k cr`
      )
    );
  }

  // The ear's half of the bill, same honesty contract: seconds are exact —
  // counted where audio is forwarded to Scribe — and the dollars carry their
  // assumed rate beside them. Absent entirely on a browser-ear harness, where
  // listening is free and a $0.0000 row would only invite the question.
  const stt = planLimits?.stt;
  if (stt?.seconds) {
    box.append(el('h3', null, 'Listening'));
    box.append(statRow('audio', `${stt.seconds}s`));
    box.append(statRow('cost', `≈$${stt.usd.toFixed(4)}`));
    box.append(el('div', 'snote', `scribe_v2_realtime · $${stt.usdPerHour}/hr assumed`));
  }

  // Additive and server-driven: render the windows that are actually present
  // rather than the ones the shape says might be.
  box.append(el('h3', null, `Plan${planLimits?.subscription ? ` · ${planLimits.subscription}` : ''}`));
  const lim = planLimits?.limits;
  const windows = lim
    ? [
        ['5-hour', lim.five_hour],
        ['7-day', lim.seven_day],
        ['7-day opus', lim.seven_day_opus],
        ['7-day sonnet', lim.seven_day_sonnet],
        ...(lim.model_scoped ?? []).map((m) => [m.display_name, m]),
      ].filter(([, w]) => w && typeof w.utilization === 'number')
    : [];

  if (!planLimits) box.append(el('div', 'snote', 'checking…'));
  // Covers both honest absences: an API-key/Bedrock/Vertex session has no plan,
  // and a future SDK that drops the method reports the same nothing. Neither is
  // actionable differently, and neither is an error.
  else if (!planLimits.available) box.append(el('div', 'snote', 'no plan windows for this session'));
  else if (!windows.length) box.append(el('div', 'snote', 'no windows reported'));
  else for (const [name, w] of windows) {
    box.append(statRow(name, `${Math.round(w.utilization)}%${w.resets_at ? ` · ${untilWhen(w.resets_at)}` : ''}`, w.utilization));
  }
}

async function loadPlanUsage() {
  try {
    planLimits = await (await fetch('/api/usage')).json();
  } catch {
    // A failed fetch must not empty the panel — the local numbers are the point.
    planLimits = { available: false };
  }
  if (statsOpen) renderStats();
}

function toggleStats() {
  statsOpen = !statsOpen;
  $('stats').hidden = !statsOpen;
  $('ctx-meter').classList.toggle('open', statsOpen);
  if (!statsOpen) return;
  renderStats();
  // Re-read on every open: a window that reset while the panel was shut is
  // exactly the thing you opened it to find out about.
  void loadPlanUsage();
  void pollContext().then(paintMeter);
}

/** Context grows DURING a turn, so the meter is polled rather than left stale. */
async function pollContext() {
  try {
    const c = await (await fetch('/api/context')).json();
    if (typeof c.percentage === 'number') ctxPct = c.percentage;
  } catch {
    /* keep the last known value — a failed poll is not news */
  }
}

function setBusy() {
  const busy = turnInFlight || workersRunning > 0;
  if (busy && !busyTick) {
    busySince = Date.now();
    void pollContext();
    // One second is the resolution of the clock; context is polled far less
    // often, because it costs a round trip and moves in steps, not smoothly.
    let ticks = 0;
    busyTick = setInterval(() => {
      if (++ticks % 5 === 0) void pollContext();
      paintProgress();
    }, 1000);
  } else if (!busy && busyTick) {
    clearInterval(busyTick);
    busyTick = null;
  }
  paintProgress();
}

// --- voice ------------------------------------------------------------------

const voiceBtn = $('voice-toggle');
/** `?voicedebug` or localStorage — the transcript churn is diagnostic, not news. */
const VOICE_DEBUG =
  new URLSearchParams(location.search).has('voicedebug') || localStorage.getItem('voicedebug') === '1';
// The glyphs are inline SVG in the markup and the state is carried entirely by
// the class — grey off, green armed-and-free, red live-and-billed, and the CSS
// swaps in a warning triangle on error. Nothing here may set textContent on the
// button: that would delete the SVG children.

// --- live speech preview -----------------------------------------------------
//
// The transcript already arrives over the open websocket and billing is by
// connection duration, so showing it costs nothing. It makes the settle window
// legible: Danny can see what was heard and watch it grow before it is sent.

/** True while the composer is displaying speech rather than something typed. */
let speechOwnsInput = false;

// --- autosend ----------------------------------------------------------------
//
// A settled utterance sending itself is what makes voice a CONVERSATION, and it
// is also what makes dictation impossible: there is no way to say a sentence,
// look at it, and fix the word the recogniser got wrong, because it is already
// gone. So the ear and the send are separated. Held speech lands in the composer
// and stays there until Enter, exactly like something typed.
//
// One person's preference on one machine, so it lives beside the collapsed
// sections rather than on the server.
const AUTOSEND_KEY = 'harness.autosend';
let autosend = localStorage.getItem(AUTOSEND_KEY) !== '0';

/**
 * Where the utterance in flight starts in the composer, while holding.
 *
 * ⚠️ This is what makes a SECOND sentence possible. Every settle resets the
 * recogniser's own accumulation (`carry`, `consumedUpTo`), so the next utterance
 * arrives as if the box were empty — and rendering it the way autosend does
 * would overwrite the sentence still sitting there unsent. Null between
 * utterances, which is the signal to append to whatever the box holds now,
 * whether that was spoken or typed.
 */
let heldBase = null;

/**
 * Speech, held. Appends rather than replaces, so nothing in the box is ever
 * destroyed by talking — which is also why there is no "composer is busy"
 * refusal here: with nothing being sent there is nothing to protect against.
 * The one case it declines is typing MID-utterance, where the words already
 * rendered are ours and his edit is not, and rewriting from the base would take
 * his edit with it.
 */
function showHeld(text) {
  if (heldBase !== null && !speechOwnsInput) return false;
  if (!text) return heldBase !== null;
  if (heldBase === null) heldBase = input.value ? `${input.value.replace(/\s+$/, '')} ` : '';
  speechOwnsInput = true;
  input.value = heldBase + text;
  input.classList.add('interim');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  return true;
}

/**
 * The utterance stopped changing. Nothing goes out — it just stops being
 * provisional: the styling drops and the base is released, so the next sentence
 * appends after this one instead of replacing it.
 */
function commitHeld(text) {
  if (!showHeld(text)) return false;
  heldBase = null;
  input.classList.remove('interim');
  return true;
}

/** True when speech owns the composer — false means something typed is in it. */
function showInterim(text) {
  // Never clobber something typed. His words win; speech only fills a box it
  // either already owns or found empty.
  if (!speechOwnsInput && input.value.trim()) return false;
  speechOwnsInput = true;
  input.value = text;
  input.classList.add('interim');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  return true;
}

function clearInterim() {
  if (!speechOwnsInput) return;
  // ⚠️ While holding, the box is a DRAFT and not a preview. A turn being
  // published is what calls this, and that is broadcast — so the other tab
  // publishing something would otherwise reach across and delete a sentence
  // sitting here unsent. Sending from here already empties the box itself.
  if (!autosend) return;
  speechOwnsInput = false;
  input.value = '';
  input.classList.remove('interim');
  input.style.height = 'auto';
}

function renderVoice(status, detail) {
  if (!status) return;
  // No cost readout: there is nothing to meter. What is left is whether she can
  // speak at all — a missing key or voice id, said on the button.
  if (status.reason) voiceBtn.title = status.reason;
  // Every ASR revision carries a detail, so this is one console line per partial
  // transcript — forty of them while a television talks nearby, which reads as a
  // runaway loop when it is only the recogniser changing its mind. Opt in.
  if (detail && VOICE_DEBUG) console.log('[voice]', detail);
}

/**
 * The composer placeholder is the readiness cue.
 *
 * Danny asked for an indicator of when it is OK to talk, independent of when he
 * DOES talk — and the button alone is a poor carrier for that: it is 46px, in
 * the corner, and he is looking at the text field he is about to speak into.
 * The placeholder is where his eyes already are, and it is only ever visible
 * when the field is empty, which is exactly when he is about to start.
 */
const PLACEHOLDER = {
  // Replaced on `hello` with the bound repo's director — see setDirectorName.
  off: 'Talk to the director…',
  listening: 'Listening — go ahead',
  // Holding. "Go ahead" would be a lie by omission: the words land and then
  // nothing happens, and the cue is the only place that says what sends them.
  holding: 'Listening — Enter sends',
  error: 'Voice unavailable — type instead',
};

/** The readiness cue for the state we are in, which autosend is half of. */
function paintPlaceholder(state = voice?.state ?? 'off') {
  if (speechOwnsInput) return;
  input.placeholder = (state === 'listening' && !autosend ? PLACEHOLDER.holding : PLACEHOLDER[state]) ?? PLACEHOLDER.off;
}

/**
 * Call her what her project calls her. The harness holds the role and the bound
 * repo holds the person, so the page cannot know the name until `hello` — and
 * "Talk to Beth" on someone else's repo is just wrong.
 */
function setDirectorName(name) {
  if (!name) return;
  PLACEHOLDER.off = `Talk to ${name}…`;
  if (voice?.state !== 'listening') paintPlaceholder();
}

/**
 * The ear. Built at `hello` rather than at load, because it wants the settle
 * window the server is configured with — one knob for both ends.
 */
let voice = null;
/** Which ear this page runs — 'browser' or 'scribe'. Set at `hello`. */
let earKind = 'browser';

function paintVoiceButton(state, detail) {
  voiceBtn.className = `voice ${state}`;
  paintPlaceholder(state);
  voiceBtn.title =
    (state === 'listening'
      ? earKind === 'scribe'
        ? 'Listening over Scribe — punctuated, biased to this project, metered by the second.'
        : 'Listening. Recognition is local, nothing is billed, and there is no channel to lose.'
      : state === 'error'
        ? (detail ?? 'voice error')
        : 'Voice off') + '  (keypad 0)';
  if (detail) console.log('[voice]', detail);
}

/** The Listener contract, shared by both ears — see remoteEar.js for why. */
function voiceCallbacks() {
  return {
    onState: (state, detail) => {
      paintVoiceButton(state, detail);
      // Reasoning effort follows the MIC. It used to follow a paid session opening
      // and closing, which was only ever standing in for this: spoken conversation
      // trades depth for latency, and typed work keeps full effort.
      if (state === 'listening' || state === 'off') post('/api/listening', { on: state === 'listening' });
    },
    // The composer IS the preview: he watches the words arrive, punctuated as
    // they will be sent, in the box they will be sent from.
    // ⚠️ While holding, an EMPTY interim must not clear the box — there may be a
    // finished sentence in it waiting for Enter, and the recogniser reports empty
    // the moment it starts the next one.
    onInterim: (text) => (autosend ? (text ? showInterim(text) : clearInterim()) : showHeld(text)),
    // Straight through the ordinary send, so a spoken turn carries the chips he
    // pointed at and honours /clear and /stop exactly like a typed one. Only send
    // what speech actually OWNS: if he is mid-way through typing something the
    // composer is his, and sending would fire his half-written line instead.
    onSettled: (text) => {
      if (!autosend) {
        if (!commitHeld(text)) entry('activity', (n) => (n.textContent = `🎙 heard "${text}" — composer is busy, not added`));
        return;
      }
      if (showInterim(text)) send();
      else entry('activity', (n) => (n.textContent = `🎙 heard "${text}" — composer is busy, not sent`));
    },
    isSpeaking: spk.isSpeaking,
    stopSpeaking: spk.stop,
  };
}

function buildBrowserListener(hello) {
  return new Listener({
    settleMs: hello.settleMs,
    // The project's own nouns, assembled server-side — the harness knows what
    // this repo is called and what is on the board; the page only speaks them.
    phrases: hello.keyterms ?? [],
    boost: hello.keytermBoost,
    ...voiceCallbacks(),
  });
}

function buildVoice(hello) {
  if (voice) return;
  earKind = hello.ear ?? 'browser';
  if (earKind === 'scribe') {
    voice = new RemoteEar({
      streamId: () => myStreamId,
      ...voiceCallbacks(),
      // The engine gave up — quota, outage, a bad key. The mic stays a mic:
      // swap in the browser ear mid-conversation and say so, once.
      onDegraded: (detail) => {
        entry('activity', (n) => (n.textContent = `🎙 Scribe ear degraded (${detail ?? 'unknown'}) — using browser recognition`));
        earKind = 'browser';
        const wasOn = voice?.state !== 'off';
        voice = listenSupported ? buildBrowserListener(hello) : null;
        if (voice && wasOn) void voice.arm().catch((e) => paintVoiceButton('error', String(e)));
        else paintVoiceButton(voice ? 'off' : 'error', voice ? undefined : 'no fallback recogniser');
      },
    });
    paintVoiceButton(voice.state);
    return;
  }
  if (!listenSupported) {
    // Say so rather than presenting a mic button that cannot work.
    paintVoiceButton('error', 'This browser has no speech recognition — Chrome does.');
    voiceBtn.disabled = true;
    // Nothing to hold back, so it is a control over nothing.
    autosendBtn.disabled = true;
    return;
  }
  voice = buildBrowserListener(hello);
  paintVoiceButton(voice.state);
}

const toggleVoice = async () => {
  // Nothing to toggle until `hello` has said which ear this harness has.
  if (!voice) return;
  try {
    if (voice.state === 'off') await voice.arm();
    else await voice.off();
  } catch (e) {
    voiceBtn.className = 'voice error';
    voiceBtn.title = String(e);
  }
};
voiceBtn.onclick = toggleVoice;

const autosendBtn = $('autosend-toggle');

function paintAutosend() {
  autosendBtn.className = `autosend ${autosend ? 'on' : 'off'}`;
  autosendBtn.title = autosend
    ? 'Speech sends itself once you stop talking — click to hold it in the composer instead'
    : 'Speech is held in the composer — edit it, then press Enter to send. Click to send automatically again.';
}

autosendBtn.onclick = () => {
  autosend = !autosend;
  localStorage.setItem(AUTOSEND_KEY, autosend ? '1' : '0');
  paintPlaceholder();
  // Whatever was accumulating belongs to the mode it was accumulating under: the
  // words already in the box stay, but the next utterance starts a fresh base
  // rather than continuing one taken under the other rule.
  heldBase = null;
  paintAutosend();
};
paintAutosend();

// Keypad 0 toggles voice from anywhere, INCLUDING while the composer has focus —
// the composer is autofocused, so a hotkey that deferred to it would never fire
// when it is actually wanted. Only Numpad0 is taken; the top-row 0 still types.
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Numpad0' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  e.preventDefault();
  void toggleVoice();
});

// --- collapsible side sections ----------------------------------------------
// Plans sits last and grows, so it survives whatever the queues above do. The
// collapse state is remembered — a section Danny closed should stay closed.

const COLLAPSE_KEY = 'harness.collapsedSections';
const collapsedSections = new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]'));

for (const sect of document.querySelectorAll('.sect')) {
  const name = sect.dataset.sect;
  if (collapsedSections.has(name)) sect.classList.add('collapsed');
  sect.querySelector('h2').onclick = (e) => {
    // The scope toggle lives inside the heading and is not a collapse control.
    if (e.target.closest('button')) return;
    sect.classList.toggle('collapsed');
    sect.classList.contains('collapsed') ? collapsedSections.add(name) : collapsedSections.delete(name);
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsedSections]));
  };
}

/** Counts on the headings, so a collapsed section still says what is in it. */
function setSectionCounts(decisions, workers) {
  $('pending-count').textContent = decisions ? String(decisions) : '';
  $('workers-count').textContent = workers ? String(workers) : '';
}

async function loadAllWork() {
  const r = await fetch('/api/work?scope=all').then((x) => x.json());
  workItems = r.items;
  workTotal = r.items.length;
  renderWork();
}

$('work-scope').onclick = async () => {
  if (workScope === 'all') {
    workScope = 'in-flight';
    const r = await fetch('/api/work').then((x) => x.json());
    workItems = r.items;
    renderWork();
    return;
  }
  workScope = 'all';
  // Everything past in-flight is reference material — collapsed until asked for.
  for (const s of ALL_ORDER) if (s !== 'active') collapsedGroups.add(s);
  await loadAllWork();
};

// --- the stream, and surviving losing it -------------------------------------
//
// Danny hit the failure this guards: text stopped appearing in the transcript
// while Beth could still be HEARD reading it. Both come off the same bus, so the
// messages existed — the page's EventSource had died. Two things made that
// silent. ConversationBus swallows a throwing subscriber, so a dead SSE writer
// fails forever without complaint; and EventSource only auto-retries some
// failures, so a closed one stays closed. The page looked like a director who
// had stopped answering.
//
// So: watch the connection, say so on screen when it is down, and rebuild it.

let streamSeenHello = false;
let stream = null;
let reconnectDelay = 1000;

function setStreamHealth(ok, detail) {
  document.body.classList.toggle('stream-down', !ok);
  if (!ok) {
    statusState = 'error';
    dotTitle = detail ?? 'Lost the connection to the harness — retrying…';
  } else {
    // Clear OUR error, rather than leaving the dot stuck red. The replayed
    // status (or the next one) sets the real state a moment later.
    statusState = 'idle';
    dotTitle = '';
  }
  paintDot();
}

function openStream() {
  stream = new EventSource('/api/stream');

  stream.onopen = () => {
    reconnectDelay = 1000;
    setStreamHealth(true);
  };

  stream.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    // The server replays the whole history on every connect, so a RECONNECT
    // would append the entire transcript a second time. `hello` arrives first on
    // each connection, which makes it the reliable signal to start clean.
    if (m.type === 'hello') {
      if (streamSeenHello) {
        transcript.replaceChildren();
        askCards.clear();
        approvalCards.clear();
      }
      streamSeenHello = true;
    }
    try {
      handlers[m.type]?.(m);
    } catch (e) {
      // One bad message must not take the transcript down with it, and a render
      // fault should be visible rather than looking like silence from Beth.
      console.error('[ui] handler failed', m.type, e);
      entry('error', (n) => (n.textContent = `⚠ failed to render a ${m.type} message — ${String(e).slice(0, 160)}`));
    }
  };

  stream.onerror = () => {
    // EventSource retries CONNECTING itself; only a CLOSED one is ours to rebuild.
    setStreamHealth(false);
    if (stream.readyState === EventSource.CLOSED) {
      stream.close();
      setTimeout(openStream, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    }
  };
}
openStream();

$('ctx-meter').onclick = toggleStats;
$('test-light').onclick = toggleTestPanel;
// Click-away closes them. These are glances, not modes — anything that makes one
// feel like a dialog is wrong.
document.addEventListener('click', (e) => {
  if (statsOpen && !e.target.closest('#stats') && !e.target.closest('#ctx-meter')) toggleStats();
  if (testPanelOpen && !e.target.closest('#test-panel') && !e.target.closest('#test-light')) toggleTestPanel();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // A glance closes first — the overlays before the panels, because they are on
  // top. Only when there is nothing to dismiss does Escape mean what it means
  // in Claude Code — and the button is small now, so the keyboard has to reach
  // the same thing your hand does.
  if (lightboxOpen || pendingOverlayOpen) {
    if (lightboxOpen) closeLightbox();
    if (pendingOverlayOpen) closePendingOverlay();
    return;
  }
  if (statsOpen || testPanelOpen) {
    if (statsOpen) toggleStats();
    if (testPanelOpen) toggleTestPanel();
    return;
  }
  stopAll();
});
paintMeter();

// --- composer --------------------------------------------------------------

const input = $('input');
const send = () => {
  const text = input.value.trim();
  // A turn can be pure gesture: click a plan, hit send, "tell me about this".
  if (!text && !refs.length) return;
  input.value = '';
  input.style.height = 'auto';
  speechOwnsInput = false;
  heldBase = null;
  input.classList.remove('interim');
  // Muscle memory from Claude Code — these never reach the model.
  if (text === '/clear') return void post('/api/clear');
  if (text === '/stop') return void post('/api/interrupt');
  post('/api/turn', { text, refs, seq: ++pointSeq });
  refs = [];
  renderRefs();
};
/**
 * Empty the composer without destroying the undo stack.
 *
 * Setting `.value` directly wipes Chrome's undo history, and Stop now clears a
 * box that may hold something typed — so it goes through the editing surface
 * instead, and ⌘Z brings it back. `execCommand` is deprecated and this is a
 * Chrome-only page (the ear needs Chrome); the assignment is the fallback.
 */
function clearComposer() {
  if (input.value) {
    input.focus();
    input.select();
    if (!document.execCommand?.('delete')) input.value = '';
  }
  speechOwnsInput = false;
  heldBase = null;
  input.classList.remove('interim');
  input.style.height = 'auto';
}

/**
 * The one button, and what it is really for.
 *
 * Recognition gets a sentence wrong often enough that the composer needs a way
 * to say "not that" — and the window between bad words appearing and the turn
 * being sent is a couple of seconds, so it has to be one action, not three.
 *
 * ⚠️ ORDER. The ear is abandoned BEFORE the box is emptied: the recogniser is
 * still holding those words, and clearing first would let its next result render
 * them straight back into the field we just cleared.
 */
const stopAll = () => {
  voice?.abandon();
  clearComposer();
  post('/api/interrupt');
};
$('interrupt').onclick = stopAll;
$('model-select').onchange = (e) => post('/api/model', { model: e.target.value });

/**
 * Reflect the mode the SERVER is in, not the one that was clicked — the switch is
 * a live call on the session and the strip must not claim it landed before it did.
 * `data-mode` carries the colouring: looser than "ask" should be visible without
 * reading the menu.
 */
function setPermissionMode(mode) {
  const sel = $('perm-select');
  sel.value = mode;
  sel.dataset.mode = mode;
}
$('perm-select').onchange = (e) => post('/api/permission-mode', { mode: e.target.value });

/**
 * Same contract again: the level the SESSION is on, not the one that was picked.
 *
 * It shows the CHOICE rather than what is in force — the mic ducks effort while
 * it is open, and a select that dropped to `low` every time he reached for the
 * microphone would look like the harness overriding him rather than borrowing it.
 */
function setEffortLevel(level) {
  const sel = $('effort-select');
  sel.value = level ?? '';
  sel.dataset.level = level ?? '';
}
$('effort-select').onchange = (e) => post('/api/effort', { level: e.target.value });

/**
 * The directors on this machine, and who is in force.
 *
 * ⚠️ Absent entirely when there are none. A dropdown offering only "the repo's
 * director" is a control with one option that does nothing, and this harness has
 * worked without personas from the beginning — that path stays exactly as it was.
 */
function setPersonas(personas, chosen) {
  const sel = $('persona-select');
  sel.hidden = personas.length === 0;
  if (sel.hidden) return;
  sel.replaceChildren();
  // '' is a real choice and stays on the menu: it hands her back to whatever the
  // bound repo says, which is the only way to undo a switch.
  for (const { slug, name } of [{ slug: '', name: 'repo default' }, ...personas]) {
    const opt = el('option', '', name);
    opt.value = slug;
    sel.append(opt);
  }
  sel.value = chosen;
  current.persona = chosen;
}

$('persona-select').onchange = async (e) => {
  const sel = e.target;
  const name = sel.options[sel.selectedIndex]?.textContent ?? 'that director';
  // ⚠️ ASK FIRST. The system prompt is fixed when the session is built, so
  // becoming someone else is a new session — the same loss as /clear, and a
  // dropdown that silently threw away an hour of conversation would be the
  // worst thing on this page. The revert is why `current` is read back.
  if (!confirm(`Talk to ${name}?\n\nThis starts a new conversation — the current one is cleared.`)) {
    sel.value = current.persona;
    return;
  }
  current.persona = sel.value;
  await post('/api/persona', { slug: sel.value });
};

/** What the page believes is in force, so a cancelled switch can put it back. */
const current = { persona: '' };

/**
 * The voices on the account, for auditioning.
 *
 * Fetched after `hello` rather than shipped with it: the list costs a call to
 * ElevenLabs, and opening a conversation must not wait on one. An empty list —
 * no key, no permission, no network — draws no control at all, the same rule the
 * persona select follows.
 */
async function loadVoices() {
  const sel = $('voice-select');
  const r = await fetch('/api/voices').then((x) => x.json()).catch(() => null);
  const voices = r?.voices ?? [];
  sel.hidden = voices.length === 0;
  if (sel.hidden) return;
  sel.replaceChildren();
  for (const v of voices) {
    const opt = el('option', '', v.name);
    opt.value = v.id;
    sel.append(opt);
  }
  // Only if the voice in force is one of hers — a persona can name an id that is
  // not on this account, and a select silently showing the wrong name would be
  // worse than one showing none.
  sel.value = voices.some((v) => v.id === r.current) ? r.current : '';
}

// ⚠️ No confirm and no persistence, unlike the persona switch. Trying a voice
// costs nothing and undoes itself: a reload, or picking a persona, puts her back
// to whatever her file says.
$('voice-select').onchange = (e) => post('/api/voice', { voiceId: e.target.value });

/** Same contract as the permission mode: the SERVER's level, not the click's. */
function setSpeechLevel(level) {
  const sel = $('speech-select');
  sel.value = level;
  sel.dataset.level = level;
}
$('speech-select').onchange = (e) => post('/api/speech', { level: e.target.value });

// The machine's mute and volume. No optimistic paint on the mute: the echo is
// one loopback SSE hop away, and the button showing the SERVER's state is the
// same contract every other strip control keeps.
$('mute-toggle').onclick = () => post('/api/voice/room', { muted: !roomState.muted });
{
  const slider = $('volume-slider');
  let settle = null;
  slider.addEventListener('input', () => {
    // This page tracks the thumb live; the room hears about it throttled — a
    // drag fires dozens of inputs, and each POST fans out to every tab of
    // every harness on the machine.
    spk.setVolume(Number(slider.value) / 100);
    if (settle) return;
    settle = setTimeout(() => {
      settle = null;
      post('/api/voice/room', { volume: Number(slider.value) / 100 });
    }, 150);
  });
  // The release always sends the final value — the throttle above may have
  // fired mid-drag and stopped short of where the thumb ended up.
  slider.addEventListener('change', () => post('/api/voice/room', { volume: Number(slider.value) / 100 }));
}
input.addEventListener('input', () => {
  // Typing takes the box back from the speech preview.
  if (speechOwnsInput) {
    speechOwnsInput = false;
    input.classList.remove('interim');
  }
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
