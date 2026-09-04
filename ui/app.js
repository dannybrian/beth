// Minimal vanilla UI — no framework, no build step. The plan calls for
// "Lit/vanilla"; at this size vanilla DOM keeps the dependency count at zero.
import { Listener, listenSupported } from '/listen.js';
import { RemoteEar } from '/remoteEar.js';
import { createSpeaker } from '/speaker.js';
import { createWirePanel } from '/wire.js';
import { addRereadButtons } from '/reread.js';
import { tabTitle } from '/title.js';
import { testFailureText, commandOutputText, sizeLabel } from '/paste.js';
import { parseBlocks, renderBlocks } from '/md.js';
import { createBell } from '/bell.js';
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

function openInEditor(link) {
  // vscode://file/<abs>[:line] is a well-defined scheme and needs no local server.
  const abs = `${repoPath}/${link.path}`;
  window.location.href = `vscode://file${abs}${link.line ? `:${link.line}` : ''}`;
}

/** A proven file link that is a picture. An image is looked at, not edited. */
const IMAGE_LINK = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
/** ...and one that is prose. Read in the harness rather than handed to an editor. */
const MD_LINK = /\.(md|markdown)$/i;

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
  const mod = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+';
  // ⚠️ Markdown by EXTENSION, not by `kind`. A plan she cites is kind 'plan',
  // but she links ordinary docs too and those are kind 'file' — and sending
  // those to a `vscode://` prompt is the exact interruption the in-harness
  // reader exists to remove. What `kind` decides is whether the reader's header
  // carries plan actions, not whether it opens.
  const readable = MD_LINK.test(link.path);
  a.title = readable
    ? `${link.path}\nClick to read it here · ${mod}click to open in VSCode`
    : `${link.path}\nClick to open in VSCode`;
  a.onclick = (e) => {
    e.preventDefault();
    if (readable && !(e.metaKey || e.ctrlKey)) {
      // READ it, and ONLY read it. Pointing used to ride along here, which was
      // wrong twice over: opening something to look at it is not the same act as
      // telling Beth to hold it, and the chip is SYNCED — so a glance quietly
      // changed what his next turn would say. Pointing stays a deliberate
      // gesture: the row's name, or the ⌖ in this reader's own header.
      openPlanPreview(link.path);
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
  // ⚠ Answered asks STAY in the map — the dedup above is what stops a replay
  // rebuilding a card that was already settled — so "is anything still waiting"
  // cannot be map size. It is this flag.
  const entry = { card, settle: null, live: true };
  const answered = () => {
    entry.live = false;
    paintTitle();
  };

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
        answered();
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
    answered();
  };

  entry.settle = settle;
  askCards.set(m.id, entry);
  add(card);
  paintTitle();
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
  paintTitle();
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
  paintTitle();
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

/** A worker card, for the side panel's roster. */
function renderWorker(w) {
  const n = el('div', 'item running');
  n.append(el('div', null, w.description));
  // The model only when the call named one — a worker that inherited its
  // model says nothing here rather than borrowing the session's, which would
  // be wrong exactly where you are looking to find out what this is costing.
  const meta = el(
    'div',
    'meta',
    [w.agentType ?? 'agent', w.model, `started ${new Date(w.startedAt).toLocaleTimeString()}`]
      .filter(Boolean)
      .join(' · ')
  );
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

/**
 * Read a plan in the harness.
 *
 * READ-ONLY, structurally: the body is rendered from a GET and there is no path
 * back — the harness does not write plan files (planName.ts is the one narrow
 * exception and it is reached from the header, not the body), so the checkboxes
 * are disabled rather than merely un-wired. The header carries the panel row's
 * own controls because this is where you are standing when you decide to act.
 */
let planOverlayOpen = false;

async function openPlanPreview(path) {
  const box = $('plan-overlay');
  // Provisional, from whatever the panel happens to hold. ⚠ Usually NOTHING:
  // `byPathAll` is the in-flight slice and cited plans are mostly finished, so
  // the real title and actions come from the response below.
  const known = byPathAll.get(path);
  $('plan-title').textContent = known?.spoken ?? path.split('/').pop();
  $('plan-path').textContent = path;
  $('plan-actions').replaceChildren(...(known ? planActions(known) : []));
  const body = $('plan-body');
  body.replaceChildren(el('div', 'snote', 'reading…'));
  box.hidden = false;
  planOverlayOpen = true;
  try {
    const res = await fetch(`/api/plan?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? res.status);
    // Still the plan he asked for? A second click while the first was in flight
    // would otherwise paint the wrong body under the right title.
    if (!planOverlayOpen || $('plan-path').textContent !== path) return;
    // The server's answer wins: it can see the whole index, this page cannot.
    // Only a real work item gets ACTIONS — they all act on one, and half would
    // 404 on an ordinary doc — but anything markdown gets read.
    const item = data.item ?? known;
    if (item) {
      $('plan-title').textContent = item.spoken ?? item.title ?? data.title;
      $('plan-actions').replaceChildren(...planActions(item));
    } else {
      $('plan-title').textContent = data.title ?? path.split('/').pop();
    }
    body.replaceChildren(renderBlocks(parseBlocks(data.text), (href) => followPlanLink(href, path)));
    body.scrollTop = 0;
  } catch (e) {
    body.replaceChildren(el('div', 'snote', `⚠ could not read ${path} — ${String(e.message ?? e)}`));
  }
}

/**
 * A link inside a plan. Plans reference each other constantly and usually by
 * BARE FILENAME, so resolve against the index — a sibling first, since that is
 * what the convention means, then any unique match by basename.
 */
function followPlanLink(href, from) {
  if (/^[a-z]+:/i.test(href)) return void window.open(href, '_blank', 'noreferrer');
  const clean = href.replace(/^\.\//, '').split('#')[0];
  if (byPathAll.has(clean)) return void openPlanPreview(clean);
  const sibling = `${from.split('/').slice(0, -1).join('/')}/${clean}`;
  if (byPathAll.has(sibling)) return void openPlanPreview(sibling);
  const base = clean.split('/').pop();
  const hits = [...byPathAll.keys()].filter((k) => k.endsWith(`/${base}`));
  // Same rule as a cited number: one match or nothing. Opening a plausible
  // wrong plan is worse than saying the link went nowhere.
  if (hits.length === 1) return void openPlanPreview(hits[0]);
  if (hits.length) return void alert(`Ambiguous link — ${hits.length} plans match ${base}`);
  // Not in the index, but plans link ordinary docs constantly. The endpoint
  // proves it is real markdown inside the repo, so let it answer rather than
  // refusing here on a guess; a miss comes back as a message in the sheet.
  if (/\.(md|markdown)$/i.test(clean)) return void openPlanPreview(sibling);
  alert(`Not something this harness can read:\n${href}`);
}

function closePlanPreview() {
  $('plan-overlay').hidden = true;
  $('plan-body').replaceChildren();
  planOverlayOpen = false;
}
$('plan-close').onclick = closePlanPreview;
$('plan-overlay').onclick = (e) => {
  // Click OFF the sheet dismisses; inside it must not, or every link closes it.
  if (e.target === $('plan-overlay')) closePlanPreview();
};

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
  // ONE of the two, cropped (see .bench in app.css). This is a clickable that
  // persists, not a readout: the whole url is in the title above and at the end
  // of the click, and a bench wide enough to hold one was crowding the dials it
  // sits between.
  const urlEl = $('bench-url');
  urlEl.textContent = short;
  urlEl.hidden = Boolean(m.label);
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
 * with room to read and answer them. Decisions only: the workers used to be
 * listed underneath, and a roster nobody opened the sheet to see was the reason
 * the sheet kept rebuilding (below).
 *
 * ⚠️ The cards are CACHED by decision id, exactly as the panel's are — a second
 * cache rather than the panel's, because one node cannot be in two places. The
 * first version built fresh nodes on every change to the pending SET, and that
 * set included the workers: a worker finishing replaced the card Danny was
 * halfway through answering with an empty one, mid-sentence, which is the same
 * bug `decisionNodes` exists to fix, one surface over. The cache also outlives a
 * close — Escape while typing, then reopening, finds the words still there.
 */
let pendingOverlayOpen = false;
let lastPending = { decisions: [], workers: [] };
const overlayNodes = new Map();
/** What the overlay last laid out, so an unchanged queue touches no DOM at all. */
let overlaySig = null;

function renderPendingOverlay() {
  const sig = lastPending.decisions.map((d) => d.id).join(',');
  if (sig === overlaySig) return;
  overlaySig = sig;
  const live = new Set(lastPending.decisions.map((d) => d.id));
  for (const id of overlayNodes.keys()) if (!live.has(id)) overlayNodes.delete(id);
  const sheet = $('pending-sheet');
  keepingFocus(sheet, () => {
    const kids = [el('h2', null, 'Pending')];
    if (!lastPending.decisions.length) kids.push(el('div', 'meta', 'Nothing waiting.'));
    for (const d of lastPending.decisions) {
      let n = overlayNodes.get(d.id);
      if (!n) {
        n = renderDecision(d);
        n.classList.add('open'); // full size is the point — no second unfold
        overlayNodes.set(d.id, n);
      }
      kids.push(n);
    }
    sheet.replaceChildren(...kids);
  });
}

function openPendingOverlay() {
  // The sheet is not kept in step while hidden, so lay it out again on open —
  // the cached cards make that a reorder, not a rebuild.
  overlaySig = null;
  renderPendingOverlay();
  $('pending-overlay').hidden = false;
  pendingOverlayOpen = true;
}

function closePendingOverlay() {
  $('pending-overlay').hidden = true;
  pendingOverlayOpen = false;
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
 * Mirror the chips to the server. Pointing is server-side state: every open tab
 * shows the same chips, and the turn that spends them may be sent from a different
 * one than the click landed in. (It predates that reason — a spoken turn used to
 * skip the page entirely — but the shared-ground one is why it stays.)
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

/**
 * Drop text into the composer as if he had typed it. NOT sent — the whole point
 * is that a log arrives with a question in front of it, and "not sending is a
 * feature" applies hardest to the paste that costs the most.
 *
 * ⚠️ Speech may own the box. What lands here is his, so take it back explicitly:
 * leave `speechOwnsInput` set and the next interim overwrites the paste, while a
 * settle appends to a `heldBase` captured before it ever arrived. Releasing and
 * nulling the base puts a paste on exactly the footing of something typed, which
 * is what it is — the next utterance then appends after it.
 */
function pasteIntoComposer(text) {
  releaseComposer();
  heldBase = null;
  const held = input.value.replace(/\s+$/, '');
  input.value = held ? `${held}\n\n${text}\n` : `${text}\n`;
  input.classList.remove('interim');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  input.focus();
  // The caret goes to the END, so the question he is about to ask lands after
  // the log rather than inside it.
  input.setSelectionRange(input.value.length, input.value.length);
  input.scrollTop = input.scrollHeight;
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

/**
 * The controls a plan carries, built once for both surfaces.
 *
 * Shared rather than copied because the preview modal exposes the same four, and
 * two copies of "rename writes to the plan file" would drift — the row is where
 * they were learned, the modal is where they are used while actually reading it.
 */
function planActions(item) {
  const out = [];

  // Point Beth at it. This used to be what clicking the NAME did, and it is now
  // an explicit control instead: reading a plan is the common act and pointing
  // at one is the deliberate act, so the big target belongs to the former. The
  // arrow is the direction the reference travels — into the composer.
  const chip = el('button', 'chip-it', '\u2192');
  chip.title = `Point Beth at "${item.spoken}"`;
  chip.onclick = (e) => {
    e.stopPropagation();
    attachRef({ kind: 'item', path: item.path, spoken: item.spoken });
  };
  out.push(chip);

  // Find it on the board. Drawn only in the reader's header (the row IS the
  // board), and it closes the sheet first — revealing a row underneath a sheet
  // that covers it is the feature doing nothing.
  const board = el('button', 'board', '\u2316');
  board.title = `Find "${item.spoken}" on the board`;
  board.onclick = (e) => {
    e.stopPropagation();
    closePlanPreview();
    revealPlan(item.path).catch(() => {});
  };
  out.push(board);

  // The shelf. A pin is an ADDITIONAL place to find a plan, never a move, so the
  // row keeps its place in the status tree either way.
  const isPinned = pinnedPaths.has(item.path);
  const pin = el('button', `pin${isPinned ? ' on' : ''}`, isPinned ? '★' : '☆');
  pin.title = isPinned ? 'Unpin' : 'Pin to the top of the panel';
  pin.onclick = (e) => {
    e.stopPropagation();
    post('/api/pin', { path: item.path, pinned: !isPinned });
  };
  out.push(pin);

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
  out.push(rename);

  // Hand off to a fresh interactive Claude Code session. Disabled outright on a
  // live claim — one implementer at a time, and the server refuses too.
  const hand = el('button', 'handoff', '\u203a_');
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
  out.push(hand);
  return out;
}

function renderWorkItem(item, depth = 0, orphanParent = null, childCount = 0) {
  const n = el('div', `item work-item status-${item.status}`);
  // What revealPlan() finds a row by.
  n.dataset.path = item.path;
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
  // The title OPENS it. A plan's name is the thing you reach for when you want
  // to know what it says, which is far more often than you want to hand the
  // reference to Beth — so the biggest target on the row does the common thing,
  // and pointing moved to the → beside it.
  name.title = `Read "${item.spoken}" — ${item.path}`;
  name.onclick = () => openPlanPreview(item.path);
  head.append(name);

  head.append(...planActions(item));
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

/**
 * Show a plan she mentioned, wherever it is hiding.
 *
 * A reference in the transcript is useless if the row is not on screen, and four
 * separate things can be hiding it: the in-flight filter, a collapsed status
 * group, a folded umbrella above it, and the scroll position. So this opens its
 * way down rather than assuming.
 *
 * ⚠️ The filter is the one that bites, and it is why this is async. The default
 * view holds ONLY in-flight plans — `byPathAll` is built from those — while the
 * plans agents cite are usually finished ("recorded that in plan 174"). Deciding
 * the row does not exist before widening and re-fetching would make the click do
 * nothing in exactly the common case.
 *
 * ⚠️ Widening is sticky on purpose. Snapping back would re-hide the row the moment
 * anything re-rendered, and the panel would flicker to a plan he never got to read.
 */
async function revealPlan(path) {
  if (!byPathAll.has(path) && workScope !== 'all') {
    workScope = 'all';
    // Same as the scope toggle: everything past in-flight is reference material,
    // collapsed until asked for — and the group we want is re-opened below.
    for (const st of ALL_ORDER) if (st !== 'active') collapsedGroups.add(st);
    await loadAllWork();
  }
  const item = byPathAll.get(path);
  if (!item) return false;
  collapsedGroups.delete(item.status);
  // Unfold every umbrella above it, not just the immediate one.
  for (let up = item.parent, guard = 0; up && guard < 20; guard++) {
    collapsedParents.delete(up);
    up = byPathAll.get(up)?.parent;
  }
  renderWork();
  const panel = $('work-panel');
  const row = panel.querySelector(`[data-path="${CSS.escape(path)}"]`);
  if (!row) return false;
  // Scroll the PANEL, not the row's ancestors. scrollIntoView walks every
  // scrollable parent, so revealing a plan could drag the transcript out from
  // under him — the message that named the plan is exactly what he is reading.
  // Measured against the panel rather than offsetTop, which would need the panel
  // to be the offset parent and silently misplaces the row when it is not.
  const rr = row.getBoundingClientRect();
  const pr = panel.getBoundingClientRect();
  const want = panel.scrollTop + (rr.top - pr.top) - (panel.clientHeight - rr.height) / 2;
  // ⚠️ Assigned, not scrollTo({behavior:'smooth'}) — which silently does NOTHING
  // in a hidden or zero-height pane (measured), and is also dropped under
  // prefers-reduced-motion. A background tab is a legitimate place to reveal a
  // row: he clicks here, then looks at the other monitor. The flash is what
  // catches the eye anyway; the animation was never the point.
  panel.scrollTop = Math.max(0, want);
  // Restart the flash even when the same row is revealed twice — without the
  // reflow the class is still there and the animation never re-runs.
  row.classList.remove('revealed');
  void row.offsetWidth;
  row.classList.add('revealed');
  return true;
}

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
    setPersonas(m.personas ?? [], m.persona ?? '');
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
    // Only ONE director runs at a time, so "director" is every session saying
    // the ordinary thing, in the busiest strip on the page. SHADOW is the one
    // worth the space: it means a terminal session holds the role and she can
    // claim nothing, which you would otherwise discover by wondering why she
    // will not take work.
    mode.hidden = m.mode === 'director';
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
    // The server drops the ghost reply when a turn begins; this is the same
    // drop a beat earlier, so the other tab's send does not leave it lingering
    // here for the round trip.
    setSuggestion(null);
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
  suggestion: (m) => setSuggestion(m.text),
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
  build: (m) => renderBuild(m.state),
  usage: (m) => {
    renderUsage(m.usage);
    ctxPct = m.usage.contextPct;
    paintProgress();
    // A turn just landed, so the plan windows just moved. This is the only
    // moment they do, which is what makes the interval above a backstop.
    void loadPlanUsage();
  },
  status: (m) => {
    // The EDGE, not the level: `status` repeats, and a bell on every idle
    // message would ring through anything that republished it.
    const turnEnded = turnInFlight && m.state !== 'thinking';
    turnInFlight = m.state === 'thinking';
    statusState = m.state;
    setBusy();
    if (turnEnded && bellOn) bell.ring(roomVolume);
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
    setSuggestion(null);
    // The cards went with the conversation — so must the summons they earned.
    paintTitle();
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
    ? 'Voices muted — every director on this machine. Click to unmute. (The bell has its own switch.)'
    : 'Mute every director\u2019s VOICE on this machine — nothing plays, nothing is billed. The bell is separate.';
  const slider = $('volume-slider');
  // Not while he is dragging it: the echo of his own drag arriving a beat late
  // would yank the thumb out from under the pointer.
  if (document.activeElement !== slider) slider.value = String(Math.round(m.volume * 100));
  roomVolume = m.volume;
  paintBell();
}

/**
 * The end-of-turn tone.
 *
 * ⚠️ INDEPENDENT of the voice mute, by Danny's call, and the reasoning is his
 * use: he works muted. The mute exists so three directors do not talk over each
 * other — it is about her VOICE, and about not paying for audio nobody wanted.
 * A bell is neither: it costs nothing, says nothing, and is most useful exactly
 * when she is not speaking, because then it is the only signal a turn ended. It
 * has its own switch; that switch is the one that governs it.
 *
 * It still rides the machine VOLUME, which is a level rather than a mute — drag
 * that to zero and the desk really is silent.
 *
 * Kept in localStorage rather than the gear: a preference of this PAGE, like
 * autosend, not something a repo has an opinion about.
 */
const bell = createBell();
let bellOn = localStorage.getItem('bell') !== 'off';
let roomVolume = 1;

function paintBell() {
  const b = $('bell-toggle');
  b.classList.toggle('on', !bellOn);
  b.title = bellOn
    ? 'A soft tone when a turn finishes — click to silence it. Independent of the voice mute.'
    : 'No tone when a turn finishes — click to enable';
}
$('bell-toggle').onclick = () => {
  bellOn = !bellOn;
  localStorage.setItem('bell', bellOn ? 'on' : 'off');
  paintBell();
  // Ring on the way ON, so the choice is audible at the moment it is made —
  // and this click is also the gesture that unlocks the audio context.
  if (bellOn) bell.ring(roomVolume);
};
// Any gesture will do; the first turn's bell should not be the one spent
// unlocking the context.
document.addEventListener('pointerdown', () => bell.unlock(), { once: true });

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
  if (blockedInline()) reasons.push('stopped on a card');
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
 * because truncation eats the back: ❗ when she is stopped on a card, then
 * decisions waiting on Danny (the browser-tab convention for "unread, yours"),
 * then the running dot, ⚠ instead when the server reports an error. The string
 * itself is built in title.js, where it is tested.
 *
 * The mic is deliberately NOT here: Chrome paints its own recording badge on
 * any tab holding the mic, hidden or not, and a title glyph would be a copy of
 * an indicator the page cannot fake — trust the browser's.
 */
/**
 * Is she STOPPED, waiting on a card in the transcript?
 *
 * Deliberately not folded into the `(N)` count. The queue is designed to be
 * ignorable — a decision lands there precisely BECAUSE she is not blocked on it
 * — so counting a card into the same number would say "three things to read
 * sometime" about a session that is halted right now. And `canUseTool` pends
 * forever with no timeout (see askgate.ts), so the only other tell is silence,
 * which reads as a hang — the exact failure this glyph exists to end.
 *
 * ⚠ Not `askCards.size`: answered asks STAY in that map, because the dedup on
 * render is what stops a replay rebuilding a settled card. Liveness is the flag.
 */
const blockedInline = () => approvalCards.size > 0 || [...askCards.values()].some((a) => a.live);

function paintTitle() {
  const t = tabTitle({
    base: titleBase,
    blocked: blockedInline(),
    decisions: decisionsWaiting,
    error: statusState === 'error',
    running: turnInFlight || workersRunning > 0,
    testLight: testState?.light,
  });
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
  const pct = Math.min(100, ctxPct);
  const heat = ctxPct >= 85 ? ' hot' : ctxPct >= 60 ? ' warm' : '';
  const ctx = $('ctx-meter');
  ctx.firstElementChild.style.setProperty('--fill', `${pct}%`);
  ctx.className = `ctx${heat}`;
  ctx.title = `Context ${ctxPct.toFixed(1)}% used — click for the numbers`;
  // The same number, in the strip, beside the windows it belongs with. Both
  // gauges stay: the bottom one is where your eye already is mid-conversation,
  // the top one is where the other two meters are — and they open the same
  // panel, which now hangs from the strip.
  const um = $('um-ctx');
  const track = um.querySelector('.sbar');
  track.className = `sbar${heat}`;
  track.firstElementChild.style.width = `${pct}%`;
  um.title = `Context ${ctxPct.toFixed(1)}% used`;
  renderUsageMeters();
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
  // `running` carries the PULSE, not `yellow` — see the .tlight rules in app.css.
  btn.className = `tlight ${state.light}${state.running ? ' running' : ''}`;
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
  if (gearOpen) renderGear();
  // The tab carries the light too — it is the only part of this page visible
  // while you are looking at something else.
  paintTitle();
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
  // Says what it is doing while it does it. The runner already refuses to
  // overlap itself, so disabling is not what stops a second run — it is what
  // stops the press from looking like it did nothing.
  const now = el('button', 'topt ghost', s.running ? 'Running…' : 'Run now');
  now.disabled = s.running;
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
      const row = el('div', 'tfail');
      const body = el('button', 'tfail-body');
      body.append(el('div', 'tname', f.spoken));
      if (f.path) body.append(el('div', 'tloc', `${f.path}${f.line ? `:${f.line}` : ''}`));
      if (f.detail) body.append(el('div', 'tdetail', f.detail));
      // Same machinery as a plan: a reference PAIR, so she gets a name she can
      // say and the location underneath — not a paragraph of stack trace.
      body.onclick = () => {
        attachRef({ kind: 'test', path: f.path ?? '', spoken: f.spoken, line: f.line, detail: f.detail });
        toggleTestPanel();
      };
      row.append(body);
      // The other half: sometimes the answer IS the stack trace. Pointing stays
      // the click, because it is right far more often; this is the escape hatch
      // beside it rather than a replacement for it.
      row.append(pasteButton(() => testFailureText(f), 'Paste this failure into the composer', () => toggleTestPanel()));
      box.append(row);
    }
  }

  if (r.output.trim()) {
    const head = el('div', 'thead');
    head.append(el('h3', null, 'Output'));
    head.append(
      pasteButton(
        () => commandOutputText({ kind: 'Test', command: s.command, result: r }),
        'Paste the whole run into the composer',
        () => toggleTestPanel()
      )
    );
    box.append(head);
    // Whatever the parsers could not read is still here, which is always better
    // than nothing — and the TAIL is what matters when a suite fails late.
    // ⚠️ The slice is the DISPLAY only. The paste above sends what the harness
    // actually kept (runCommand caps at 256 KB, tail-first), because output that
    // stops mid-sentence is worse than no output: she answers it anyway.
    box.append(el('pre', 'tlog', r.output.slice(-8000)));
  }
}

/**
 * The paste control, which says what it is about to spend.
 *
 * The size is on the button rather than behind it: a 200 KB log and a 400 B
 * failure are the same gesture and wildly different turns, and the only moment
 * that difference can be seen is before the click.
 */
function pasteButton(build, title, after) {
  const text = build();
  const b = el('button', 'tpaste', `⇥ ${sizeLabel(text)}`);
  b.title = `${title} — not sent, so you can ask something in front of it`;
  b.onclick = (e) => {
    e.stopPropagation();
    pasteIntoComposer(text);
    after?.();
  };
  return b;
}

function toggleTestPanel() {
  testPanelOpen = !testPanelOpen;
  $('test-panel').hidden = !testPanelOpen;
  $('test-light').classList.toggle('open', testPanelOpen);
  if (testPanelOpen) renderTestPanel();
}

// --- the gear ----------------------------------------------------------------
//
// Two dials that were never worth strip width, and the two commands the lights
// run. The commands are the reason it exists: they are the first thing the page
// WRITES into config, and config has three read-only layers underneath — so the
// one rule that makes it liveable is that the panel says which layer won. See
// src/settings.ts.

let gearOpen = false;
/** The raw overrides, which is what the boxes hold — not what is in force. */
let gearSettings = {};

function renderGear() {
  const box = $('gear-commands');
  box.replaceChildren();
  for (const [key, label, state, note] of [
    ['testCmd', 'test', testState, 'What answers “is the tree green”.'],
    ['buildCmd', 'build', buildState, 'Must terminate — a dev server here sticks the light on yellow.'],
  ]) {
    const row = el('div', 'setrow');
    row.append(el('label', null, label));
    const input = el('input');
    input.type = 'text';
    input.value = gearSettings[key] ?? '';
    // The placeholder is the INHERITED answer, so an empty box shows what it is
    // falling back to rather than looking like nothing is configured.
    input.placeholder = state?.command?.join(' ') ?? 'nothing detected';
    input.title = note;
    const commit = () => {
      if ((gearSettings[key] ?? '') === input.value.trim()) return;
      void post('/api/settings', { [key]: input.value.trim() }).then(loadGearSettings);
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') input.blur();
      // Escape belongs to the panel, not to the box — but not while you are
      // mid-edit: put the old value back first, and let the next one close.
      if (e.key === 'Escape') {
        e.stopPropagation();
        input.value = gearSettings[key] ?? '';
        input.blur();
      }
    };
    input.onblur = commit;
    row.append(input);
    const why = el('div', 'setwhy');
    if (!state?.command) why.textContent = 'nothing detected here';
    else {
      why.append(el('b', null, state.command.join(' ')));
      why.append(document.createTextNode(` — ${state.why}`));
    }
    row.append(why);
    box.append(row);
  }
}

async function loadGearSettings() {
  gearSettings = await fetch('/api/settings')
    .then((r) => r.json())
    .catch(() => gearSettings);
  if (gearOpen) renderGear();
}

function toggleGear(open = !gearOpen) {
  gearOpen = open;
  $('gear-panel').hidden = !gearOpen;
  $('gear').classList.toggle('open', gearOpen);
  if (!gearOpen) return;
  // Re-read on every open: another tab may have set one, and what is DETECTED
  // changes with the repo underneath us.
  renderGear();
  void loadGearSettings();
}

// --- the build light ---------------------------------------------------------
//
// The test light's colours and the test light's gesture: a READOUT you click to
// inspect, with the panel holding the controls. It used to be the opposite — a
// click RAN the build — and that made a look cost a build: opening the panel to
// read the last failure kicked off another run over the top of the tree you were
// still editing. The quick trigger is the keypad (`buildNow`), which runs AND
// opens, so the output is where you are already looking. The two buttons are
// always both there and take turns being live, so the panel's shape never
// changes under the cursor between a press and the state that follows it.

let buildState = null;
let buildPanelOpen = false;

function renderBuild(state) {
  buildState = state;
  const btn = $('build-light');
  // `running` carries the PULSE, not `yellow` — see the .tlight rules in app.css.
  btn.className = `tlight ${state.light}${state.running ? ' running' : ''}`;
  const r = state.last;
  btn.title =
    (!state.command
      ? 'No build detected — set HARNESS_BUILD_CMD'
      : state.running
        ? 'Building…'
        : !r
          ? `Build — ${state.command.join(' ')}`
          : r.cancelled
            ? 'Stopped'
            : r.timedOut
              ? 'Timed out'
              : (r.exitCode ?? 1) !== 0
                ? `Failed (exit ${r.exitCode})${state.stale ? ' — and the tree has changed since' : ''}`
                : state.stale
                  ? 'Built, but the tree has changed since'
                  : 'Built') + '  (keypad 1)';
  if (buildPanelOpen) renderBuildPanel();
  // The gear shows what each light RUNS, so it moves when a light does.
  if (gearOpen) renderGear();
}

function renderBuildPanel() {
  const box = $('build-panel');
  box.replaceChildren();
  const s = buildState;
  if (!s) return;

  box.append(el('h3', null, 'Build'));
  if (!s.command) {
    box.append(
      el('div', 'snote', 'Nothing detected here. Set HARNESS_BUILD_CMD in the repo’s .env to name one — it runs to completion, so not a dev server.')
    );
    return;
  }

  const cmd = el('div', 'tcmd', s.command.join(' '));
  cmd.title = `detected from ${s.why}`;
  box.append(cmd);

  const run = el('button', 'topt', s.running ? 'Building…' : 'Build');
  run.disabled = s.running;
  run.onclick = () => post('/api/build/run');
  box.append(run);
  const stop = el('button', 'topt ghost', 'Stop');
  stop.disabled = !s.running;
  stop.onclick = () => post('/api/build/stop');
  box.append(stop);

  const r = s.last;
  if (!r) return void (s.running || box.append(el('div', 'snote', 'no build yet')));

  box.append(el('h3', null, 'Last build'));
  const when = new Date(r.at).toLocaleTimeString();
  const how = r.cancelled ? 'stopped' : r.timedOut ? 'TIMED OUT' : `exit ${r.exitCode}`;
  box.append(
    el('div', 'snote', `${when} · ${(r.ms / 1000).toFixed(1)}s · ${how}${s.stale ? ' · tree changed since' : ''}`)
  );

  if (r.output.trim()) {
    const head = el('div', 'thead');
    head.append(el('h3', null, 'Output'));
    // With no parser there is no failure row to point at, so the paste is the
    // ONLY way a build reaches her with its reasons attached. It matters more
    // here than on the test side, not less.
    head.append(
      pasteButton(
        () => commandOutputText({ kind: 'Build', command: s.command, result: r }),
        'Paste the whole build into the composer',
        () => toggleBuildPanel(false)
      )
    );
    box.append(head);
    // No parser here yet, deliberately: a compiler-error parser written against
    // output nobody has seen fail is worth very little (see CLAUDE.md). The TAIL
    // is what matters when a build dies late.
    box.append(el('pre', 'tlog', r.output.slice(-8000)));
  }
}

function toggleBuildPanel(open = !buildPanelOpen) {
  buildPanelOpen = open;
  $('build-panel').hidden = !buildPanelOpen;
  $('build-light').classList.toggle('open', buildPanelOpen);
  if (buildPanelOpen) renderBuildPanel();
}

/**
 * The key. Runs unless one is already running — in which case this is just a
 * way to look at it, which is the only reading of a second press that cannot
 * cost anything. The click is `toggleBuildPanel`, same as the test light.
 */
function buildNow() {
  if (buildState?.command && !buildState.running) post('/api/build/run');
  toggleBuildPanel(true);
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
  // A weekday name is only an answer inside one week — the plan windows never
  // exceed that, but the credit cycle resets monthly and "Tue" three weeks out
  // is a guess dressed as a fact.
  if (h < 24 * 7) return new Date(iso).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function bar(pct) {
  const wrap = el('span', `sbar${pct >= 85 ? ' hot' : pct >= 60 ? ' warm' : ''}`);
  const fill = el('i');
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  wrap.append(fill);
  return wrap;
}

/**
 * The windows actually present, in the order they matter.
 *
 * Server-driven: render what came back rather than what the shape says might be
 * there — the plan tiers differ and the field names have moved once already.
 * The panel draws all of them; the strip draws the first two.
 */
function planWindows(lim) {
  if (!lim) return [];
  return [
    ['5-hour', lim.five_hour],
    ['7-day', lim.seven_day],
    ['7-day opus', lim.seven_day_opus],
    ['7-day sonnet', lim.seven_day_sonnet],
    ...(lim.model_scoped ?? []).map((m) => [m.display_name, m]),
  ].filter(([, w]) => w && typeof w.utilization === 'number');
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

  // The credit countdown. Absent entirely unless a budget is configured —
  // nothing can read the real balance, so the number is Danny's and every
  // figure here is an estimate wearing its assumptions. The mode line matters
  // most: a zero must read as "not drawing credits", never as "not working".
  const cr = planLimits?.credits;
  if (cr?.available) {
    box.append(el('h3', null, 'Credits'));
    box.append(statRow('spent', `≈$${cr.spentUsd.toFixed(2)}`, (cr.spentUsd / cr.monthlyUsd) * 100));
    box.append(statRow('left', `≈$${Math.max(0, cr.remainingUsd).toFixed(2)} of $${cr.monthlyUsd}`));
    box.append(statRow('resets', untilWhen(cr.resetsAt)));
    box.append(
      el('div', 'snote', cr.armed ? 'metering — a plan window is at 100%' : 'not drawing credits — plan windows still open')
    );
    box.append(el('div', 'snote', "list price, this machine's beths only, counted while a window is exhausted"));
  }

  // Additive and server-driven: render the windows that are actually present
  // rather than the ones the shape says might be.
  box.append(el('h3', null, `Plan${planLimits?.subscription ? ` · ${planLimits.subscription}` : ''}`));
  const windows = planWindows(planLimits?.limits);

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

/**
 * The two windows that matter, in the strip.
 *
 * Only two: the model-scoped ones are a panel-sized answer and the strip is for
 * the glance. Each track is hidden on its own, because a plan that reports one
 * window and not the other should draw the one it has rather than nothing.
 */
function renderUsageMeters() {
  const btn = $('usage-meters');
  const lim = planLimits?.limits;
  const said = [];
  for (const [id, label, w] of [
    ['um-5h', '5-hour', lim?.five_hour],
    ['um-7d', '7-day', lim?.seven_day],
  ]) {
    const um = $(id);
    const has = w && typeof w.utilization === 'number';
    um.hidden = !has;
    if (!has) continue;
    const pct = Math.max(0, Math.min(100, w.utilization));
    const track = um.querySelector('.sbar');
    track.className = `sbar${pct >= 85 ? ' hot' : pct >= 60 ? ' warm' : ''}`;
    track.firstElementChild.style.width = `${pct}%`;
    // `untilWhen` answers with a duration inside a day and a DATE beyond one,
    // so the preposition cannot be fixed: "resets in 3h", but "resets Wed".
    const when = w.resets_at ? untilWhen(w.resets_at) : '';
    said.push(`${label} ${Math.round(w.utilization)}%${when ? ` · resets ${/^\d/.test(when) ? 'in ' : ''}${when}` : ''}`);
  }
  // ⚠️ The plan windows are absent entirely rather than drawn empty — an
  // API-key, Bedrock or Vertex session has no plan, and an unfillable gauge is
  // worse than no gauge. CONTEXT is not like that: every session has one, so
  // the button now survives on the ctx bar alone.
  said.push(`context ${ctxPct.toFixed(1)}%`);
  btn.hidden = false;
  // The tie-in worth having at exactly this glance: a window at 100% is when
  // usage credits begin to drain, and `armed` is the server's own verdict on
  // that — it counts the model-scoped windows the strip does not draw.
  const cr = planLimits?.credits;
  btn.title =
    said.join('\n') +
    (cr?.available && cr.armed ? `\ndrawing credits — ≈$${Math.max(0, cr.remainingUsd).toFixed(2)} left` : '') +
    '\n\nclick for the numbers';
}

async function loadPlanUsage() {
  let next;
  try {
    next = await (await fetch('/api/usage')).json();
  } catch {
    // A failed fetch must not empty the panel — the local numbers are the point.
    next = { available: false };
  }
  // ⚠️ Keep the last windows we actually saw. `planUsage()` needs a LIVE query,
  // so the moment after a /clear — and every moment before the first turn —
  // honestly reports no plan at all. In a panel you open deliberately that is
  // fine; in the strip it is a gauge that blanks mid-session, which reads as
  // broken rather than as asked-at-a-bad-time. The windows only move on a turn
  // anyway, so the kept ones are not stale in any way that matters.
  if (!planWindows(next.limits).length && planWindows(planLimits?.limits).length) {
    next = {
      ...next,
      available: planLimits.available,
      subscription: planLimits.subscription,
      limits: planLimits.limits,
    };
  }
  planLimits = next;
  renderUsageMeters();
  if (statsOpen) renderStats();
}

function toggleStats() {
  statsOpen = !statsOpen;
  $('stats').hidden = !statsOpen;
  $('ctx-meter').classList.toggle('open', statsOpen);
  $('usage-meters').classList.toggle('open', statsOpen);
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
  releaseComposer();
  input.value = '';
  input.classList.remove('interim');
  input.style.height = 'auto';
}

/**
 * Speech has let go of the composer, so the readiness cue has to be repainted.
 *
 * ⚠️ Every release, not just this one. `paintPlaceholder` declines to touch the
 * cue while speech owns the box — nothing is visible to fix there, the box is
 * not empty — so a mic switched off MID-HOLD paints nothing, and the "Listening
 * — Enter sends" left behind reappears the moment the box next empties, with the
 * ear long since off. Which reads as a mic that will not turn off.
 */
function releaseComposer() {
  speechOwnsInput = false;
  paintPlaceholder();
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
  // The suggested reply displaces the cue while it stands. Deliberate: the cue
  // says the field is ready, the ghost says what to put in it, and a box can
  // show one string. The mic button still carries the listening state, and the
  // cue comes straight back when the ghost goes.
  if (suggestion) {
    input.placeholder = suggestion;
    input.classList.add('suggesting');
    suggestHint.hidden = false;
    return;
  }
  input.classList.remove('suggesting');
  suggestHint.hidden = true;
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

// The keypad, from anywhere INCLUDING while the composer has focus — it is
// autofocused, so a hotkey that deferred to it would never fire when it is
// actually wanted. Only the Numpad codes are taken; the top row still types.
//   0 — the mic        1 — build        2 — run the tests
// Both of the run keys open their panel too: firing something off and then
// having to go and find where it went would be a worse gesture than the click.
// ⚠ The keys are the only TRIGGERS on the page; both lights' clicks just open.
const KEYPAD = {
  Numpad0: () => void toggleVoice(),
  Numpad1: buildNow,
  Numpad2: () => {
    if (testState?.command) post('/api/tests/run');
    if (!testPanelOpen) toggleTestPanel();
  },
};
document.addEventListener('keydown', (e) => {
  const act = KEYPAD[e.code];
  if (!act || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  // ⚠️ The composer is the deliberate exception; a settings BOX is not. `make
  // -j4` has a numeral in it, and typing one must not kick off a build instead.
  if (e.target instanceof HTMLInputElement) return;
  e.preventDefault();
  act();
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

/**
 * The stream can die WITHOUT anyone noticing, and that is the whole reason this
 * exists.
 *
 * A half-open socket — a sleep, a network change, a proxy giving up — leaves the
 * browser believing it is connected. No `onerror`, nothing in the console,
 * nothing in the terminal; the page simply stops receiving. Danny's symptom was
 * exact: bits of the conversation missing, no error anywhere, a refresh brings
 * them back — and because POSTing a turn uses its own connection and still
 * works, he ends up saying things twice while her answers never arrive.
 *
 * So the page counts the server's pulse. ⚠️ It arms only after a FIRST ping has
 * actually landed: a harness that predates the ping never sends one, and a
 * watchdog that armed regardless would tear down a perfectly good stream every
 * minute against every server Danny has not restarted. Same rule as the mute —
 * a change to what passes between page and server has to degrade, not misfire.
 */
/**
 * A turn you sent that never came back.
 *
 * The page does not render your own words locally — it waits for the bus to echo
 * them, so every tab agrees and the ordering is the server's. That makes an
 * unnoticed dead stream look precisely like Danny described: you type, the
 * composer empties, and nothing appears. His words for it were "I don't see my
 * own answer without a refresh."
 *
 * ⚠️ This is the check that needs NO cooperation from the server, which is why it
 * exists alongside the ping. The ping proves the stream is alive but only against
 * a harness new enough to send one; this proves the stream is CARRYING, using a
 * fact the page already owns — I sent something, so it must come back. An old
 * harness gets the benefit too, and that matters because the ones that have been
 * up for days are exactly the ones whose sockets have had time to rot.
 */
const ECHO_GRACE_MS = 6_000;
let awaitingEchoSince = 0;

function expectEcho() {
  if (!awaitingEchoSince) awaitingEchoSince = Date.now();
}

const STREAM_SILENT_MS = 55_000; // pings land every 20s; three missed is dead
let lastStreamAt = Date.now();
let sawPing = false;
let healedSilently = false;

setInterval(() => {
  // A turn that never echoed is proof the stream has stopped carrying, whatever
  // it claims about being open. Rebuild it: the replay holds the missing turn
  // (verified — a turn published with no stream attached is still in history),
  // so the reconnect is what puts his words back on the page.
  if (awaitingEchoSince && Date.now() - awaitingEchoSince > ECHO_GRACE_MS) {
    awaitingEchoSince = 0;
    rebuildStream('your message did not come back');
    return;
  }
  // ⚠️ Deliberately NOT skipped for a hidden tab. A background tab is exactly
  // where this rots unseen — two monitors, and the one you are not looking at is
  // the one you trust when you finally look. Network events are not throttled,
  // so its pings keep landing and a healthy hidden tab never trips this.
  if (!sawPing) return;
  if (Date.now() - lastStreamAt < STREAM_SILENT_MS) return;
  // ⚠️ The note is deferred to AFTER the reconnect, not written here: `hello`
  // clears the transcript and the replay rebuilds it, so a line written now is
  // erased by the very reconnect it describes. It has to land at the bottom of
  // the restored conversation, which is where he is reading.
  rebuildStream('the connection went quiet');
}, 2_500);

function rebuildStream(why) {
  healedSilently = why;
  lastStreamAt = Date.now();
  try {
    stream?.close();
  } catch {
    /* already gone */
  }
  openStream();
}

function openStream() {
  stream = new EventSource('/api/stream');

  stream.onopen = () => {
    reconnectDelay = 1000;
    lastStreamAt = Date.now();
    setStreamHealth(true);
    // Say so rather than healing invisibly. This is rare, and when it happens
    // the question "did I miss something?" deserves an answer — Danny's tell was
    // repeating himself, so the note has to be where he is looking, after the
    // replay has finished putting the conversation back.
    if (healedSilently) {
      const why = healedSilently;
      healedSilently = false;
      setTimeout(
        () => entry('activity', (n) => (n.textContent = `⟳ ${why} — reconnected, and this is current`)),
        800
      );
    }
  };

  stream.onmessage = (ev) => {
    // ANY traffic is proof of life, including a message we do not render.
    lastStreamAt = Date.now();
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.type === 'ping') {
      sawPing = true;
      return;
    }
    // Our own words came back — whichever tab sent them, the stream is carrying.
    if (m.type === 'user') awaitingEchoSince = 0;
    // The server replays the whole history on every connect, so a RECONNECT
    // would append the entire transcript a second time. `hello` arrives first on
    // each connection, which makes it the reliable signal to start clean.
    if (m.type === 'hello') {
      if (streamSeenHello) {
        transcript.replaceChildren();
        askCards.clear();
        approvalCards.clear();
        // The replay that follows re-renders any card still live and repaints
        // as it goes; this covers the case where it re-renders none.
        paintTitle();
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
$('usage-meters').onclick = toggleStats;
$('test-light').onclick = toggleTestPanel;
$('build-light').onclick = () => toggleBuildPanel();
$('gear').onclick = () => toggleGear();
void loadGearSettings();
// The windows move once a TURN, which is why the usage handler re-reads them;
// this interval is for the long quiet stretches — another beth on the same
// account, or a window rolling over while nothing happens here. A hidden tab
// does not poll: this is an SDK round-trip, and three harnesses with a couple
// of tabs each is a lot of asking after a number nobody is looking at.
const USAGE_POLL_MS = 60_000;
setInterval(() => {
  if (document.visibilityState === 'visible') void loadPlanUsage();
}, USAGE_POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void loadPlanUsage();
});
void loadPlanUsage();
// Click-away closes them. These are glances, not modes — anything that makes one
// feel like a dialog is wrong.
document.addEventListener('click', (e) => {
  if (
    statsOpen &&
    !e.target.closest('#stats') &&
    !e.target.closest('#ctx-meter') &&
    !e.target.closest('#usage-meters')
  ) {
    toggleStats();
  }
  if (testPanelOpen && !e.target.closest('#test-panel') && !e.target.closest('#test-light')) toggleTestPanel();
  if (buildPanelOpen && !e.target.closest('#build-panel') && !e.target.closest('#build-light')) toggleBuildPanel(false);
  if (gearOpen && !e.target.closest('#gear-panel') && !e.target.closest('#gear')) toggleGear(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // A glance closes first — the overlays before the panels, because they are on
  // top. Only when there is nothing to dismiss does Escape mean what it means
  // in Claude Code — and the button is small now, so the keyboard has to reach
  // the same thing your hand does.
  if (lightboxOpen || pendingOverlayOpen || planOverlayOpen) {
    if (lightboxOpen) closeLightbox();
    if (pendingOverlayOpen) closePendingOverlay();
    if (planOverlayOpen) closePlanPreview();
    return;
  }
  if (statsOpen || testPanelOpen || buildPanelOpen || gearOpen) {
    if (statsOpen) toggleStats();
    if (testPanelOpen) toggleTestPanel();
    if (buildPanelOpen) toggleBuildPanel(false);
    if (gearOpen) toggleGear(false);
    return;
  }
  // A ghost reply on an empty box is the last dismissable thing before Escape
  // means stop. Local only: the other tab keeps its own until the turn goes.
  if (suggestion && !input.value) {
    setSuggestion(null);
    return;
  }
  stopAll();
});
paintBell();
paintMeter();

// --- composer --------------------------------------------------------------

const input = $('input');
const send = () => {
  const text = input.value.trim();
  // A turn can be pure gesture: click a plan, hit send, "tell me about this".
  if (!text && !refs.length) return;
  input.value = '';
  input.style.height = 'auto';
  releaseComposer();
  heldBase = null;
  input.classList.remove('interim');
  // Sent, so whatever was suggested is answered — by this or by something else.
  setSuggestion(null);
  // Muscle memory from Claude Code — these never reach the model.
  if (text === '/clear') return void post('/api/clear');
  if (text === '/stop') return void post('/api/interrupt');
  post('/api/turn', { text, refs, seq: ++pointSeq });
  expectEcho();
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
  releaseComposer();
  heldBase = null;
  input.classList.remove('interim');
  input.style.height = 'auto';
}

// --- the suggested reply ----------------------------------------------------
//
// Her guess at his next line (`suggest_reply`, suggestion.ts), shown as the
// composer's placeholder and taken with Tab. The placeholder is the whole
// "only if I haven't typed" rule: the browser shows it only while the box is
// empty, so nothing here has to watch keystrokes, and a sentence half-typed
// hides it by itself. Text in the box is his; the ghost never competes with it.

let suggestion = null;
const suggestHint = $('suggest-hint');

function setSuggestion(text) {
  suggestion = text || null;
  paintPlaceholder();
}

/**
 * Tab. Into the box, not sent — the same as Claude Code, and the point: he
 * reads it as his own line for a beat, edits it or not, and Enter sends it.
 * Goes through the editing surface so ⌘Z takes it back out, like clearComposer.
 */
function acceptSuggestion() {
  if (!suggestion || input.value.trim()) return false;
  const text = suggestion;
  input.focus();
  if (!document.execCommand?.('insertText', false, text)) input.value = text;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  input.setSelectionRange(input.value.length, input.value.length);
  return true;
}
// Document-level rather than on the field: after a click in the transcript the
// composer has lost focus, and Tab should still take the line rather than walk
// the focus ring. Only from the field or from nothing — a Tab inside a settings
// box means what it always means.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target !== input && e.target !== document.body) return;
  if (acceptSuggestion()) e.preventDefault();
});

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
  // The select lives behind the gear now, so the gear carries the tell: anything
  // but `auto` changes how often a spoken conversation can be stopped dead, and
  // that has to be legible without opening a panel to look.
  $('gear').classList.toggle('loose', mode !== 'auto');
  $('gear').title = mode === 'auto' ? 'Settings' : `Settings — permissions: ${sel.selectedOptions[0]?.text ?? mode}`;
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

// A voice PICKER used to live here — the account's voices, auditioned live so an
// id could be found by ear. It is gone (2026-08-31): a voice is part of a
// persona, named by the `voice:` line in her file, and a second way to choose
// one was a control that only ever undid itself on the next reload.

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
/**
 * ⚠️ BOTH, and the pair is the point.
 *
 * `toggleMute` is the intent, and a new server prefers it — a page whose belief
 * has gone stale then cannot do the opposite of what its own icon shows.
 * `muted` is the computed fallback for a server that predates the intent, and it
 * is not optional: `ui/` is served fresh from disk on every load while the
 * harness is a process that has been up for days, so a reload pairs a NEW page
 * with an OLD server routinely. Sending only the intent made the button do
 * nothing at all there — dead, not stale, which is worse.
 */
$('mute-toggle').onclick = () =>
  post('/api/voice/room', { toggleMute: true, muted: !roomState.muted });
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
    releaseComposer();
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
