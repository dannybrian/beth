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

const renderUser = (m) => entry('user', (n) => n.append(el('div', 'body', m.text)));
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
  },
  user: renderUser,
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
    if (m.state === 'error' && m.detail) entry('error', (n) => (n.textContent = `⚠ ${m.detail}`));
  },
  pending: renderPending,
  voice: (m) => renderVoice(m.status, m.detail),
  event: (m) => {
    renderEvent(m);
    feedEvent(m.event);
  },
};

// --- voice ------------------------------------------------------------------

const voiceBtn = $('voice-toggle');
const LABEL = { off: '🎙 off', armed: '🎧 listening', connected: '🔴 live', error: '⚠ voice' };

function renderVoice(status, detail) {
  if (!status) return;
  $('voice-cost').textContent = status.totalUsd
    ? `voice $${status.totalUsd.toFixed(3)}${status.connected ? ` · ${status.connectedSeconds}s live` : ''}`
    : '';
  if (status.reason) voiceBtn.title = status.reason;
  if (detail) console.log('[voice]', detail);
}

const voice = new VoiceClient((state, detail) => {
  voiceBtn.textContent = LABEL[state] ?? state;
  voiceBtn.className = `voice ${state}`;
  voiceBtn.title =
    state === 'armed'
      ? 'Listening locally — free. A paid session opens when you speak.'
      : state === 'connected'
        ? 'Live session — billed per minute. Closes itself after silence.'
        : state === 'error'
          ? (detail ?? 'voice error')
          : 'Voice off';
  if (detail) console.log('[voice]', detail);
  fetch('/api/voice/status')
    .then((r) => r.json())
    .then((s) => renderVoice(s));
});

voiceBtn.onclick = async () => {
  try {
    if (voice.state === 'off') await voice.arm();
    else await voice.off();
  } catch (e) {
    voiceBtn.textContent = LABEL.error;
    voiceBtn.className = 'voice error';
    voiceBtn.title = String(e);
  }
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
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';
  post('/api/turn', { text });
};
$('send').onclick = send;
$('interrupt').onclick = () => post('/api/interrupt');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
