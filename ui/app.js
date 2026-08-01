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
const renderAssistant = (m) => entry('assistant', (n) => n.append(el('div', 'body', m.text)));

const renderSay = (m) =>
  entry('say', (n) => {
    n.append(el('span', 'tag', m.kind));
    n.append(el('div', 'body', m.text));
    if (m.ref) n.append(el('span', 'ref', m.ref));
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

function renderWorkItem(item) {
  const n = el('div', `item work-item status-${item.status}`);
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

  if (expanded.has(item.path)) {
    const list = el('div', 'tasks');
    for (const task of item.tasks) list.append(renderTask(item, task));
    n.append(list);
  }
  return n;
}

// In-flight first, then the rest in roughly the order work moves through them.
const IN_FLIGHT_ORDER = ['active', 'blocked', 'planning'];
const ALL_ORDER = [...IN_FLIGHT_ORDER, 'idea', 'unknown', 'parked', 'shipped'];

/** 'in-flight' (the default) or 'all'. The panel is a work surface, not an archive. */
let workScope = 'in-flight';
let workTotal = 0;

function renderWork() {
  const panel = $('work-panel');
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

  for (const status of workScope === 'all' ? ALL_ORDER : IN_FLIGHT_ORDER) {
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

    if (open) for (const item of group) panel.append(renderWorkItem(item));
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
    renderUser(m);
  },
  assistant: renderAssistant,
  say: (m) => {
    renderSay(m);
    feedEvent({ ts: new Date().toISOString(), kind: `say/${m.kind}`, text: m.text });
  },
  activity: renderActivity,
  ask: renderAsk,
  ask_resolved: (m) => askCards.get(m.id)?.classList.add('answered'),
  approval: renderApproval,
  approval_resolved: () => {},
  usage: (m) => renderUsage(m.usage),
  status: (m) => {
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

const voice = new VoiceClient((state, detail) => {
  voiceBtn.className = `voice ${state}`;
  voiceBtn.title =
    (state === 'armed'
      ? 'Listening locally — free. A paid session opens when you speak.'
      : state === 'connected'
        ? 'Live session — billed per minute. Closes itself after silence.'
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
