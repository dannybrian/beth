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

/** Body text with proven file references spliced in as links. */
function bodyWithLinks(text, links) {
  const div = el('div', 'body');
  if (!links?.length) {
    div.textContent = text;
    return div;
  }
  let at = 0;
  for (const link of links) {
    if (link.start < at) continue; // defensive: never emit overlapping ranges
    if (link.start > at) div.append(document.createTextNode(text.slice(at, link.start)));
    div.append(linkNode(link, text.slice(link.start, link.end)));
    at = link.end;
  }
  if (at < text.length) div.append(document.createTextNode(text.slice(at)));
  return div;
}

const renderAssistant = (m) => entry('assistant', (n) => n.append(bodyWithLinks(m.text, m.links)));

const renderSay = (m) =>
  entry('say', (n) => {
    n.append(el('span', 'tag', m.kind));
    n.append(bodyWithLinks(m.text, m.links));
    // The announcement's own ref is already structured — make it the most
    // obvious thing to click.
    if (m.refLink) n.append(linkNode(m.refLink, m.refLink.spoken ?? m.ref));
    else if (m.ref) n.append(el('span', 'ref', m.ref));
  });

const renderActivity = (m) => entry('activity', (n) => (n.textContent = `⚙ ${m.tool} ${m.detail}`));
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

function renderApproval(m) {
  const card = el('div', 'card approval');
  card.append(el('span', 'hdr', `permission · ${m.tool}`));
  card.append(el('div', 'q', m.title));
  card.append(el('div', 'body', m.detail));
  const opts = el('div', 'opts');
  const decide = (allowed) => {
    post('/api/approve', { id: m.id, allowed });
    card.classList.add('answered');
    card.append(el('div', 'answer', allowed ? '→ allowed' : '→ denied'));
    opts.remove();
  };
  const yes = el('button', 'opt', 'Allow');
  yes.onclick = () => decide(true);
  const no = el('button', 'opt', 'Deny');
  no.onclick = () => decide(false);
  opts.append(yes, no);
  card.append(opts);
  add(card);
}

function renderPending(m) {
  setSectionCounts(m.decisions.length, m.workers.length);
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

function renderWorkItem(item, depth = 0, orphanParent = null) {
  const n = el('div', `item work-item status-${item.status}`);
  if (depth) n.style.marginLeft = `${depth * 11}px`;
  const head = el('div', 'work-head');

  const t = taskSummary(item);
  if (t) {
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

  const bits = [item.priority, t ? `${t.done}/${t.total} tasks` : 'no tasks'].filter(Boolean);
  // A live claim means an implementer is on it — the thing a handoff must respect.
  if (item.claim?.live) bits.push('claimed');
  else if (item.claim) bits.push('stale owner');
  const meta = el('div', 'meta', bits.join(' · '));
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
      const emit = (item, depth) => {
        const parentElsewhere = item.parent && !inGroup.has(item.parent) ? byPathAll.get(item.parent) : null;
        panel.append(renderWorkItem(item, depth, depth === 0 ? parentElsewhere : null));
        for (const k of kids.get(item.path) ?? []) emit(k, depth + 1);
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
    $('repo-label').textContent = m.repo.split('/').pop();
    const mode = $('mode-label');
    mode.textContent = m.mode;
    mode.className = `mode ${m.mode}`;
    mode.title = m.modeReason;
    if (m.model) $('model-select').value = m.model;
  },
  model: (m) => {
    $('model-select').value = m.model;
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
  approval_resolved: () => {},
  usage: (m) => renderUsage(m.usage),
  status: (m) => {
    // A turn in flight is the conversation still happening, even in silence.
    if (m.state === 'thinking') keepVoiceAlive();
    $('status-dot').className = `dot ${m.state}`;
    // A deliberate stop is not a failure — mark it quietly.
    if (m.detail === 'stopped') entry('activity', (n) => (n.textContent = '⏹ stopped'));
    else if (m.state === 'error' && m.detail) entry('error', (n) => (n.textContent = `⚠ ${m.detail}`));
  },
  pending: renderPending,
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
    $('usage-label').textContent = '';
    entry('activity', (n) => (n.textContent = '— new conversation —'));
  },
  voice: (m) => {
    // 'hearing' is a transcript revision — he is mid-sentence. Anything else
    // means that utterance is over, one way or another.
    if (m.state === 'hearing') showInterim(m.detail ?? '');
    else if (m.state === 'ignored' || m.state === 'duplicate' || m.state === 'disconnected') clearInterim();
    // The harness has something to say and no channel to say it through. Only
    // an ARMED mic opens one: voice off is a deliberate choice for silence, and
    // this must never be the thing that starts billing behind his back.
    else if (m.state === 'speak-request' && voice?.state === 'armed') {
      voice.connect('announce').catch(() => {});
    }
    renderVoice(m.status, m.detail);
  },
  event: (m) => {
    renderEvent(m);
    feedEvent(m.event);
  },
};

// --- voice ------------------------------------------------------------------

const voiceBtn = $('voice-toggle');
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
  if (detail) console.log('[voice]', detail);
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
  off: 'Talk to Beth…',
  connecting: 'Opening the mic — wait…',
  connected: 'Listening — go ahead',
  armed: 'Mic on, channel closed — speak to reopen',
  error: 'Voice unavailable — type instead',
};

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

const stream = new EventSource('/api/stream');
stream.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  handlers[m.type]?.(m);
};

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
