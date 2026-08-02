// Minimal vanilla UI — no framework, no build step. The plan calls for
// "Lit/vanilla"; at this size vanilla DOM keeps the dependency count at zero.
import { Listener, listenSupported } from '/listen.js';
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
  // Tool calls are the conversation still moving. Without this, a long stretch
  // of work emits nothing the idle timer recognises, the paid session closes
  // mid-job, and the result Danny actually wanted to hear arrives to a shut
  // channel — the exact reason a successful ship ended in silence.
  activity: (m) => {
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
  speak: (m) => enqueueSpeak(m.id),
  tests: (m) => renderTests(m.state),
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

function enqueueSpeak(id) {
  speakBacklog.push(id);
  playNextSpoken();
}

function playNextSpoken() {
  if (speakingId !== null) return;
  const id = speakBacklog.shift();
  if (id === undefined) return;
  speakingId = id;
  // HALF DUPLEX. The ear closes while she talks, because echo cancellation cannot
  // reach the recogniser's own capture — it opens its own microphone and takes no
  // constraints. Parking it is what stops her hearing herself and answering it.
  voice?.park?.();
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
  if (speakBacklog.length) return void playNextSpoken();
  // Only reopen when she has genuinely finished — between two queued lines the
  // ear would otherwise open into the gap and hear the second one.
  voice?.unpark?.();
}

/**
 * Cut her off. What half duplex costs is the ability to interrupt, and this is
 * the meter buying it back — see the barge-in gate in listen.js.
 */
function bargeIn() {
  speaker.pause();
  // A backlog she was going to read is no longer wanted: you interrupted the
  // whole thought, not one sentence of it. The transcript still has every word.
  const dropped = speakBacklog.length;
  speakBacklog.length = 0;
  speakingId = null;
  if (dropped) entry('activity', (n) => (n.textContent = `⏹ stopped speaking — ${dropped} line${dropped > 1 ? 's' : ''} not read aloud`));
  voice?.unpark?.();
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
  if (!speechOwnsInput && voice?.state !== 'listening') input.placeholder = PLACEHOLDER[voice?.state ?? 'off'] ?? PLACEHOLDER.off;
}

/**
 * The ear. Built at `hello` rather than at load, because it wants the settle
 * window the server is configured with — one knob for both ends.
 */
let voice = null;

function paintVoiceButton(state, detail) {
  voiceBtn.className = `voice ${state}`;
  if (!speechOwnsInput) input.placeholder = PLACEHOLDER[state] ?? PLACEHOLDER.off;
  voiceBtn.title =
    (state === 'listening'
      ? 'Listening. Recognition is local, nothing is billed, and there is no channel to lose.'
      : state === 'error'
        ? (detail ?? 'voice error')
        : 'Voice off') + '  (keypad 0)';
  if (detail) console.log('[voice]', detail);
}

function buildVoice(hello) {
  if (voice) return;
  if (!listenSupported) {
    // Say so rather than presenting a mic button that cannot work.
    paintVoiceButton('error', 'This browser has no speech recognition — Chrome does.');
    voiceBtn.disabled = true;
    return;
  }
  voice = new Listener({
    settleMs: hello.settleMs,
    // The project's own nouns, assembled server-side — the harness knows what
    // this repo is called and what is on the board; the page only speaks them.
    phrases: hello.keyterms ?? [],
    boost: hello.keytermBoost,
    onState: (state, detail) => {
      paintVoiceButton(state, detail);
      // Reasoning effort follows the MIC. It used to follow a paid session opening
      // and closing, which was only ever standing in for this: spoken conversation
      // trades depth for latency, and typed work keeps full effort.
      if (state === 'listening' || state === 'off') post('/api/listening', { on: state === 'listening' });
    },
    // The composer IS the preview: he watches the words arrive, punctuated as
    // they will be sent, in the box they will be sent from.
    onInterim: (text) => (text ? showInterim(text) : clearInterim()),
    // Straight through the ordinary send, so a spoken turn carries the chips he
    // pointed at and honours /clear and /stop exactly like a typed one. Only send
    // what speech actually OWNS: if he is mid-way through typing something the
    // composer is his, and sending would fire his half-written line instead.
    onSettled: (text) => {
      if (showInterim(text)) send();
      else entry('activity', (n) => (n.textContent = `🎙 heard "${text}" — composer is busy, not sent`));
    },
    isSpeaking: () => speakingId !== null,
    stopSpeaking: bargeIn,
  });
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
  // A glance closes first. Only when there is nothing to dismiss does Escape mean
  // what it means in Claude Code — and the button is small now, so the keyboard
  // has to reach the same thing your hand does.
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
