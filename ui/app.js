// Minimal vanilla UI — no framework, no build step. The plan calls for
// "Lit/vanilla"; at this size vanilla DOM keeps the dependency count at zero.
import { VoiceClient } from '/voice.js';
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

function linkNode(link, label) {
  // `label` is optional: inside a message body the anchor's contents are built
  // from the range tree below, because a link may itself contain formatting.
  const a = el('a', `filelink ${link.kind}`, label);
  a.href = '#';
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

const renderAssistant = (m) => entry('assistant', (n) => n.append(bodyWithLinks(m.text, m.links, m.spans)));

const renderSay = (m) =>
  entry('say', (n) => {
    n.append(el('span', 'tag', m.kind));
    n.append(bodyWithLinks(m.text, m.links, m.spans));
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
  const card = el('div', 'card');
  const answers = {};
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

    card.append(block);
  }
  askCards.set(m.id, card);
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

function renderPending(m) {
  setSectionCounts(m.decisions.length, m.workers.length);
  decisionsWaiting = m.decisions.length;
  const dec = $('pending-decisions');
  dec.replaceChildren(
    ...m.decisions.map((d) => {
      const n = el('div', `item urgency-${d.urgency}`);
      n.append(el('div', null, d.title));
      n.append(el('div', 'meta', `${d.urgency}${d.plan ? ` · ${d.plan.split('/').pop()}` : ''}`));
      const b = el('button', 'resolve', 'Answer…');
      b.onclick = () => {
        const answer = prompt(`${d.title}\n\n${d.context}`, d.options?.[0] ?? '');
        if (answer) post('/api/resolve-decision', { id: d.id, answer });
      };
      n.append(b);
      return n;
    })
  );

  const wk = $('pending-workers');
  wk.replaceChildren(
    ...m.workers.map((w) => {
      const n = el('div', 'item running');
      n.append(el('div', null, w.description));
      n.append(el('div', 'meta', `${w.agentType ?? 'agent'} · started ${new Date(w.startedAt).toLocaleTimeString()}`));
      return n;
    })
  );
}

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

function renderUsage(u) {
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  $('usage-label').textContent =
    `ctx ${u.contextPct.toFixed(1)}% (${k(u.contextTokens)}/${k(u.contextMax)}) · ` +
    `turn ${k(u.turnInput)}in +${k(u.turnCached)} cached / ${k(u.turnOutput)}out · ` +
    `$${u.turnCost.toFixed(4)} turn · $${u.totalCost.toFixed(4)} total`;
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
    const project = m.repo.split('/').pop();
    $('repo-label').textContent = project;
    // Several instances run side by side, one per repo — the tab title is the
    // only way to tell them apart from the window switcher. The name comes from
    // the bound repo, so a different project's director is called what it calls
    // her rather than what this harness assumes.
    document.title = `${m.director ?? 'Director'}: ${project}`;
    setDirectorName(m.director);
    const mode = $('mode-label');
    mode.textContent = m.mode;
    mode.className = `mode ${m.mode}`;
    mode.title = m.modeReason;
    if (m.model) $('model-select').value = m.model;
    if (m.permissionMode) setPermissionMode(m.permissionMode);
    if (m.speechLevel) setSpeechLevel(m.speechLevel);
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
  },
  // The turn was sent — the preview has become a real message in the transcript.
  user: (m) => {
    clearInterim();
    keepVoiceAlive();
    renderUser(m);
  },
  assistant: (m) => {
    keepVoiceAlive();
    renderAssistant(m);
  },
  say: (m) => {
    keepVoiceAlive();
    renderSay(m);
    feedEvent({ ts: new Date().toISOString(), kind: `say/${m.kind}`, text: m.text });
  },
  // Tool calls are the conversation still moving. Without this, a long stretch
  // of work emits nothing the idle timer recognises, the paid session closes
  // mid-job, and the result Danny actually wanted to hear arrives to a shut
  // channel — the exact reason a successful ship ended in silence.
  activity: (m) => {
    keepVoiceAlive();
    renderActivity(m);
  },
  ask: renderAsk,
  ask_resolved: (m) => askCards.get(m.id)?.classList.add('answered'),
  approval: renderApproval,
  approval_resolved: (m) => resolveApprovalCard(m.id, m.allowed, m.always),
  usage: (m) => {
    renderUsage(m.usage);
    ctxPct = m.usage.contextPct;
    paintProgress();
  },
  status: (m) => {
    // A turn in flight is the conversation still happening, even in silence.
    if (m.state === 'thinking') keepVoiceAlive();
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
    $('usage-label').textContent = '';
    entry('activity', (n) => (n.textContent = '— new conversation —'));
  },
  voice: (m) => {
    // 'hearing' is a transcript revision — he is mid-sentence. Anything else
    // means that utterance is over, one way or another.
    if (m.state === 'hearing') showInterim(m.detail ?? '');
    else if (m.state === 'ignored' || m.state === 'duplicate' || m.state === 'disconnected') clearInterim();
    // She has something to say and no channel to say it through. Her voice does
    // not depend on his mic: with the mic off the session opens MUTED, so this
    // costs him a channel but never carries his words. Silence is chosen with
    // the speech level (`off`), which stops anything queueing server-side — so
    // reaching here at all means he asked to be spoken to.
    // She has something to say and no channel to say it through. Only an ARMED
    // mic opens one — not a policy but a constraint: a session can only be spoken
    // through in reply to a transcript, and a muted mic never produces one (see
    // the note in voice.js). Voice off is therefore silence, deliberately.
    else if (m.state === 'speak-request' && voice?.state === 'armed') {
      voice.connect('announce').catch(() => {});
    }
    // Something she wrote was never said. It is in the transcript, so the only
    // thing he cannot otherwise know is that he never heard it — and silence is
    // indistinguishable from a hang, which is the whole reason this is loud.
    else if (m.state === 'unspoken') {
      entry('activity', (n) => (n.textContent = `🔇 not spoken — ${m.detail ?? 'no channel was open'}`));
    }
    renderVoice(m.status, m.detail);
  },
  speak: (m) => enqueueSpeak(m.id),
  event: (m) => {
    renderEvent(m);
    feedEvent(m.event);
  },
};

// --- her voice, outbound ------------------------------------------------------
//
// The whole transport: an HTTP stream into an <audio> element. No session to
// open, no transcript to answer, no mic — which is the entire reason this
// exists, because Speech Engine can only carry a reply to something it heard.
//
// ONE line at a time. Assigning `src` while a play() is still resolving aborts
// it, and both lines are lost — the browser calls that `AbortError: interrupted
// by a new load request`, and it cost an afternoon in the spike.
const speaker = new Audio();
const speakBacklog = [];
let speakingId = null;

function enqueueSpeak(id) {
  speakBacklog.push(id);
  playNextSpoken();
}

function playNextSpoken() {
  if (speakingId !== null) return;
  const id = speakBacklog.shift();
  if (id === undefined) return;
  speakingId = id;
  speaker.src = `/api/voice/say/${encodeURIComponent(id)}`;
  speaker.play().catch((e) => {
    // Chrome refuses audio until the page has been interacted with. Say so:
    // silence is indistinguishable from a hang, which is the bug this replaces.
    entry('activity', (n) => (n.textContent = `🔇 not spoken — ${e.name === 'NotAllowedError' ? 'click the page once to allow audio' : e.message}`));
    doneSpeaking(id);
  });
}

/** Advance exactly once per line, however it ended. */
function doneSpeaking(id) {
  if (speakingId !== id) return;
  speakingId = null;
  playNextSpoken();
}

speaker.addEventListener('ended', () => doneSpeaking(speakingId));
// A failed fetch (502 from a missing permission, say) must not wedge the queue.
// The server publishes its own `unspoken` line with the reason.
speaker.addEventListener('error', () => doneSpeaking(speakingId));

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
  dot.title = err ? dotTitle : reasons.join(' · ');
}

function paintProgress() {
  const busy = turnInFlight || workersRunning > 0;
  paintDot();
  $('progress').hidden = !busy;
  // The spinner is the PREDICTION, not the work: a worker running on its own
  // leaves the timer and its count, and stops claiming she is mid-sentence.
  $('progress-spin').hidden = !turnInFlight;
  if (!busy) return;
  $('progress-time').textContent = mmss(Date.now() - busySince);
  const ctx = $('progress-ctx');
  ctx.firstElementChild.style.width = `${Math.min(100, ctxPct)}%`;
  ctx.className = `ctx${ctxPct >= 85 ? ' hot' : ctxPct >= 60 ? ' warm' : ''}`;
  ctx.title = `context ${ctxPct.toFixed(1)}% used`;
  $('progress-note').textContent = workersRunning
    ? `${workersRunning} worker${workersRunning > 1 ? 's' : ''}`
    : '';
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
  // Hold the voice channel open for the duration of the work. The wait for a
  // mouth is per session, so a job that closes and reopens one per announcement
  // pays it over and over — see WORKING_IDLE_CLOSE_MS.
  try {
    voice?.setWorking(busy);
  } catch {
    /* voice may not be armed */
  }
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

/**
 * Keep the paid session open while the CONVERSATION is moving. The local VAD only
 * knows about Danny's voice, so a long answer he listens to quietly reads as idle
 * — the session closes mid-exchange and his reply then pays for a reconnect,
 * losing its first second. Declared before the handlers that call it.
 */
const keepVoiceAlive = () => {
  try {
    voice?.touch();
  } catch {
    /* voice may not be armed */
  }
};

function showInterim(text) {
  // Never clobber something typed. His words win; speech only fills a box it
  // either already owns or found empty.
  if (!speechOwnsInput && input.value.trim()) return;
  speechOwnsInput = true;
  input.value = text;
  input.classList.add('interim');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function clearInterim() {
  if (!speechOwnsInput) return;
  speechOwnsInput = false;
  input.value = '';
  input.classList.remove('interim');
  input.style.height = 'auto';
}

function renderVoice(status, detail) {
  if (!status) return;
  $('voice-cost').textContent = status.totalUsd
    ? `voice $${status.totalUsd.toFixed(3)}${status.connected ? ` · ${status.connectedSeconds}s live` : ''}`
    : '';
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
  connecting: 'Opening the mic — wait…',
  connected: 'Listening — go ahead',
  armed: 'Mic on, channel closed — speak to reopen',
  error: 'Voice unavailable — type instead',
};

/**
 * Call her what her project calls her. The harness holds the role and the bound
 * repo holds the person, so the page cannot know the name until `hello` — and
 * "Talk to Beth" on someone else's repo is just wrong.
 */
function setDirectorName(name) {
  if (!name) return;
  PLACEHOLDER.off = `Talk to ${name}…`;
  if (!speechOwnsInput && voice?.state !== 'connected') input.placeholder = PLACEHOLDER[voice?.state ?? 'off'] ?? PLACEHOLDER.off;
}

const voice = new VoiceClient((state, detail) => {
  voiceBtn.className = `voice ${state}`;
  if (!speechOwnsInput) input.placeholder = PLACEHOLDER[state] ?? PLACEHOLDER.off;
  voiceBtn.title =
    (state === 'connecting'
      ? 'Opening the channel — do not talk yet.'
      : state === 'armed'
        ? 'Mic held, channel closed after silence. Speak to reopen (the first words may clip).'
        : state === 'connected'
          ? 'Live — go ahead. Billed per minute; closes itself after silence.'
          : state === 'error'
            ? (detail ?? 'voice error')
            : 'Voice off') + '  (keypad 0)';
  if (detail) console.log('[voice]', detail);
  fetch('/api/voice/status')
    .then((r) => r.json())
    .then((s) => renderVoice(s));
});

const toggleVoice = async () => {
  try {
    if (voice.state === 'off') await voice.arm();
    else await voice.off();
  } catch (e) {
    voiceBtn.className = 'voice error';
    voiceBtn.title = String(e);
  }
};
voiceBtn.onclick = toggleVoice;

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

// --- composer --------------------------------------------------------------

const input = $('input');
const send = () => {
  const text = input.value.trim();
  // A turn can be pure gesture: click a plan, hit send, "tell me about this".
  if (!text && !refs.length) return;
  input.value = '';
  input.style.height = 'auto';
  speechOwnsInput = false;
  input.classList.remove('interim');
  // Muscle memory from Claude Code — these never reach the model.
  if (text === '/clear') return void post('/api/clear');
  if (text === '/stop') return void post('/api/interrupt');
  post('/api/turn', { text, refs, seq: ++pointSeq });
  refs = [];
  renderRefs();
};
$('send').onclick = send;
$('interrupt').onclick = () => post('/api/interrupt');
$('clear').onclick = () => post('/api/clear');
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

/** Same contract as the permission mode: the SERVER's level, not the click's. */
function setSpeechLevel(level) {
  const sel = $('speech-select');
  sel.value = level;
  sel.dataset.level = level;
}
$('speech-select').onchange = (e) => post('/api/speech', { level: e.target.value });
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
