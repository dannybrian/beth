// WebServer — serves the UI and carries the conversation to the browser.
//
// Transport is Server-Sent Events (server→browser) + POST (browser→server)
// rather than a websocket: Node has no built-in websocket SERVER, and the plan
// treats transport as incidental. SSE is zero-dependency and reconnects on its
// own. Phase 2 can swap in a real socket if audio needs bidirectional framing.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { ConversationBus, UIMessage } from './bus.ts';
import type { EventLog } from './eventlog.ts';
import type { PendingStore } from './state.ts';
import type { AskGate } from './askgate.ts';
import type { SessionManager } from './session.ts';
import type { SpeakOut } from './speakOut.ts';
import type { TestMonitor } from './testRunner.ts';
import type { HarnessConfig } from './config.ts';
import type { WorkIndex } from './workIndex.ts';
import type { WorkRef } from './workItems.ts';
import { canPromote } from './directorRole.ts';
import { SPEECH_LEVELS, type SpeechLevel } from './spoken.ts';
import { canHandOff, handOffToClaude, seedPrompt } from './handoff.ts';
import { keyterms } from './keyterms.ts';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

/**
 * What the page may switch to. An allowlist, not a passthrough: 'bypassPermissions'
 * is a real SDK mode and a POST from a page must never be able to reach it.
 */
const PERMISSION_MODES = ['default', 'auto', 'acceptEdits', 'dontAsk'];

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

export function createServer(deps: {
  cfg: HarnessConfig;
  bus: ConversationBus;
  events: EventLog;
  pending: PendingStore;
  gate: AskGate;
  session: SessionManager;
  speakOut: SpeakOut;
  tests: TestMonitor;
  work: WorkIndex;
  /** The repo's own vocabulary, mined once at boot — see keyterms.ts. */
  mined: string[];
}) {
  const { cfg, bus, events, pending, gate, session, work } = deps;

  /**
   * What to bias the recogniser toward, for THIS page.
   *
   * Assembled per connection rather than at boot because the live plan names are
   * half of it: what he is talking about today is what has moved on the board,
   * and a term list fixed at startup would name last week's work.
   */
  const biasing = () =>
    cfg.speechBiasing
      ? keyterms({
          configured: cfg.keyterms,
          live: work.live().map((i) => i.spoken),
          mined: deps.mined,
        }).terms
      : [];

  /**
   * ONE MOUTH, however many pages are open.
   *
   * Voice used to be a machine singleton — one Speech Engine, one tunnel — so two
   * browser tabs could not both speak no matter what. Now every page can play
   * audio, and two tabs on one harness means hearing her twice, slightly out of
   * phase, on top of herself. Two tabs is a legitimate thing to have (two
   * monitors), so the answer is to elect a speaker rather than to refuse.
   *
   * Newest connection wins by default — it is almost always the one you just
   * opened — and a page claims the mouth when it takes focus, which is the tab
   * you are actually looking at.
   */
  let nextStreamId = 1;
  const streams = new Set<number>();
  let speakerId = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${cfg.port}`);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // --- SSE stream ---
    if (url.pathname === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      // ConversationBus deliberately swallows a throwing subscriber so one dead
      // consumer cannot break the bus — which means a broken SSE socket would
      // otherwise fail silently on every publish, forever. If a write throws,
      // this connection is over: tear it down so the subscriber stops being
      // called and the browser is free to reconnect.
      const streamId = nextStreamId++;
      streams.add(streamId);
      speakerId = streamId;
      let dead = false;
      let cleanup = () => {};
      const send = (m: UIMessage) => {
        if (dead) return;
        try {
          res.write(`data: ${JSON.stringify(m)}\n\n`);
        } catch {
          dead = true;
          cleanup();
        }
      };
      send({
        type: 'hello',
        repo: cfg.repo,
        mode: session.role.mode,
        modeReason: session.role.reason,
        model: session.chosenModel(),
        director: cfg.directorName,
        permissionMode: session.chosenPermissionMode(),
        speechLevel: deps.speakOut.speechLevel(),
        settleMs: cfg.voiceSettleMs,
        keyterms: biasing(),
        keytermBoost: cfg.keytermBoost,
        streamId,
      });
      send({ type: 'voice', state: 'idle', status: deps.speakOut.status() });
      for (const m of bus.replay()) send(m);
      // Re-render anything still waiting on a human.
      for (const a of gate.outstanding().asks) send({ type: 'ask', id: a.id, questions: a.questions });
      send({ type: 'pending', decisions: pending.openDecisions(), workers: pending.runningWorkers() });
      send({ type: 'tests', state: deps.tests.state() });
      // Only in-flight items go down the stream — the panel shows in-progress
      // work, and shipping all 571 of beadgame's plans on every connect is waste.
      send({ type: 'work', items: work.live(), total: work.all().length });
      // Everything broadcasts except the instruction to make a noise.
      const unsub = bus.subscribe((m) => {
        if (m.type === 'speak' && streamId !== speakerId) return;
        send(m);
      });
      // The keepalive is also how a half-open socket gets noticed at all: without
      // traffic, a connection the browser has already abandoned looks alive here.
      const keepalive = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          dead = true;
          cleanup();
        }
      }, 20_000);
      cleanup = () => {
        clearInterval(keepalive);
        streams.delete(streamId);
        // Hand the mouth on rather than leaving her mute in a page that is still
        // open — closing the speaking tab must not take the voice with it.
        if (speakerId === streamId) speakerId = streams.size ? Math.max(...streams) : 0;
        unsub();
        res.end();
      };
      req.on('close', cleanup);
      return;
    }

    // --- API ---
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'POST') {
        const body = await readJson(req);
        switch (url.pathname) {
          case '/api/point': {
            // The page mirrors its chips here so a SPOKEN turn can see them —
            // voice never touches the browser, so the reference has to live
            // server-side to survive the trip.
            work.point(Array.isArray(body.refs) ? (body.refs as WorkRef[]) : [], Number(body.seq) || undefined);
            return json(200, { ok: true });
          }
          case '/api/turn': {
            const text = String(body.text ?? '').trim();
            // The page sends its chips with the turn as well as mirroring them,
            // so a typed turn cannot race its own /api/point.
            if (Array.isArray(body.refs)) work.point(body.refs as WorkRef[], Number(body.seq) || undefined);
            // A turn may be nothing BUT a pointing gesture — clicking a plan and
            // hitting send is a legitimate "tell me about this".
            if (!text && !work.pointed().length) return json(400, { error: 'empty turn' });
            session.sendPointed(text);
            return json(200, { ok: true });
          }
          case '/api/handoff': {
            // Local-only by construction: the main server binds to loopback. See
            // handoff.ts — this spawns a shell and must never move to the public
            // listener.
            const target = String(body.path ?? '');
            const verdict = canHandOff(work, target);
            if (!verdict.ok) {
              // Refuse loudly. The transcript records it, so a refusal is visible
              // rather than a dialog Danny dismisses and forgets.
              bus.publish({ type: 'activity', tool: 'handoff', detail: `refused — ${verdict.reason}` });
              return json(409, verdict);
            }
            const prompt = seedPrompt(work, target);
            const { command } = handOffToClaude({ repo: cfg.repo, claudeBin: cfg.claudeBin, prompt });
            events.append({
              source: 'harness',
              session: session.sessionId(),
              kind: 'handoff',
              text: `handed ${target} to Claude Code`,
              ref: target,
            });
            bus.publish({ type: 'activity', tool: 'handoff', detail: `Claude Code ← ${target}` });
            // Tell the director, so she is not surprised by work starting.
            session.send(
              `FYI — Danny just handed ${target} to a fresh Claude Code session in a terminal. It will claim the plan itself. Do not start work on it.`,
              { silent: true }
            );
            return json(200, { ...verdict, command });
          }
          case '/api/answer': {
            const ok = gate.answerAsk(String(body.id), body.answers ?? {});
            return json(ok ? 200 : 404, { ok });
          }
          case '/api/approve': {
            // "Always" is an ALLOW that also carries the SDK's suggested rules,
            // scoped to this conversation — see forThisSession in askgate.ts.
            const verdict = !body.allowed ? 'deny' : body.always ? 'always' : 'once';
            const ok = gate.answerApproval(String(body.id), verdict);
            return json(ok ? 200 : 404, { ok });
          }
          case '/api/permission-mode': {
            const mode = String(body.mode ?? '');
            if (!PERMISSION_MODES.includes(mode)) return json(400, { error: 'unknown mode' });
            await session.setPermissionMode(mode as HarnessConfig['permissionMode']);
            events.append({
              source: 'harness',
              session: session.sessionId(),
              kind: 'permission_mode',
              text: `permissions → ${mode}`,
            });
            return json(200, { ok: true, mode });
          }
          case '/api/model': {
            const model = String(body.model ?? '').trim();
            if (!model) return json(400, { error: 'no model' });
            await session.setModel(model);
            return json(200, { ok: true, model });
          }
          case '/api/speech': {
            // How much of what she writes is read aloud. Voice-side only — the
            // transcript is unaffected, which is the point of having a level.
            const level = String(body.level ?? '');
            if (!(SPEECH_LEVELS as string[]).includes(level)) return json(400, { error: 'unknown level' });
            deps.speakOut.setSpeechLevel(level as SpeechLevel);
            return json(200, { ok: true, level });
          }
          case '/api/tests/enable': {
            // ⚠️ The one switch that lets this harness execute project code on a
            // schedule. Off by default, per repo, and the page shows the detected
            // command before offering it — a suite that spins containers or costs
            // money must not start because someone saved a file.
            deps.tests.setEnabled(Boolean(body.on));
            return json(200, { ok: true, state: deps.tests.state() });
          }
          case '/api/tests/run': {
            // Deliberate, so it ignores settle, interval and idleness. It still
            // refuses to overlap itself.
            void deps.tests.run();
            return json(200, { ok: true });
          }
          case '/api/voice/claim': {
            // The focused tab takes the mouth. Ignored for a stream that has
            // since closed, so a stale claim cannot mute every live page.
            const id = Number(body.streamId);
            if (streams.has(id)) speakerId = id;
            return json(200, { ok: true, speaker: speakerId });
          }
          case '/api/listening': {
            // Reasoning effort follows the MIC now.
            //
            // It used to follow the paid session opening and closing, which was
            // only ever a proxy for "he is talking to me" — spoken conversation
            // trades depth for latency, typed work keeps full effort. With no
            // session to hang off, the page says so directly, which is both
            // simpler and more accurate: the mic being open is the actual fact.
            if (!cfg.voiceEffort) return json(200, { ok: true, effort: null });
            const on = Boolean(body.on);
            await session.setEffort(on ? cfg.voiceEffort : null).catch(() => {});
            return json(200, { ok: true, effort: on ? cfg.voiceEffort : null });
          }
          case '/api/clear': {
            await session.clear();
            return json(200, { ok: true });
          }
          case '/api/interrupt': {
            const receipt = await session.interrupt();
            return json(200, { ok: true, receipt });
          }
          case '/api/resolve-decision': {
            const d = pending.resolveDecision(String(body.id), String(body.answer ?? ''));
            if (!d) return json(404, { ok: false });
            events.append({
              source: 'harness',
              session: session.sessionId(),
              kind: 'decision_resolved',
              text: `${d.title} → ${d.resolved?.answer}`,
              ref: d.plan ?? d.id,
            });
            // The answer reaches the director as an ordinary turn.
            session.send(`Decision resolved — "${d.title}": ${d.resolved?.answer}`);
            session.publishPending();
            return json(200, { ok: true });
          }
          case '/api/promote': {
            const verdict = canPromote(cfg.repo, cfg.directorPlan);
            if (verdict.ok) {
              session.send(
                `The director role is free (${verdict.reason}). Take it: run the /director resume ritual and claim ${cfg.directorPlan} normally — never with --force.`
              );
            }
            return json(200, verdict);
          }
          default:
            return json(404, { error: 'unknown endpoint' });
        }
      }
      if (url.pathname === '/api/voice/status') {
        return json(200, deps.speakOut.status());
      }
      // Audio for a line she has decided to say. This is the ENTIRE outbound
      // transport: an HTTP stream into an <audio> element, on the loopback
      // server, which is why the new plane needs no tunnel and no public port.
      if (url.pathname.startsWith('/api/voice/say/')) {
        const id = url.pathname.slice('/api/voice/say/'.length);
        try {
          const stream = await deps.speakOut.stream(id);
          res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
          const node = Readable.fromWeb(stream as any);
          node.on('error', () => res.destroy());
          req.on('close', () => node.destroy());
          return void node.pipe(res);
        } catch (e: any) {
          // Say WHY out loud. The failure that actually happens is the API key
          // missing the text_to_speech permission, and a silent 502 there reads
          // as "voice is broken" rather than as one checkbox.
          const msg = String(e?.body?.detail?.message ?? e?.message ?? e).slice(0, 300);
          console.log(`  speak-out: ${id} failed — ${msg}`);
          bus.publish({ type: 'voice', state: 'unspoken', detail: msg, status: deps.speakOut.status() });
          return json(502, { error: msg });
        }
      }
      if (url.pathname === '/api/usage') {
        // Read defensively and hand the page whatever survived. `null` here is
        // an ordinary answer — an API-key session simply has no plan windows.
        const u = await session.planUsage();
        return json(200, {
          available: Boolean(u?.rate_limits_available),
          subscription: u?.subscription_type ?? null,
          limits: (u?.rate_limits as unknown) ?? null,
          // The other bill. It rides this response because the stats panel
          // already re-reads it on every open, and speech spend is exactly the
          // kind of number you go looking for rather than watch.
          speech: deps.speakOut.spend(),
        });
      }
      if (url.pathname === '/api/context') {
        // Full category breakdown — what actually occupies the window, and the
        // prefix that gets re-read on every API round-trip.
        const ctx = await session.contextUsage();
        return json(200, ctx ?? { error: 'no session' });
      }
      if (url.pathname === '/api/work') {
        // The whole index, for anything the stream's in-flight slice can't answer
        // (search over parked/shipped work, resolving a stale reference).
        const scope = url.searchParams.get('scope');
        return json(200, { items: scope === 'all' ? work.all() : work.live() });
      }
      if (url.pathname === '/api/state') {
        return json(200, {
          repo: cfg.repo,
          mode: session.role.mode,
          modeReason: session.role.reason,
          model: session.model(),
          director: cfg.directorName,
          permissionMode: session.chosenPermissionMode(),
          speechLevel: deps.speakOut.speechLevel(),
          sessionId: session.sessionId(),
          decisions: pending.allDecisions(),
          workers: pending.allWorkers(),
          events: events.recent(30),
        });
      }
      return json(404, { error: 'unknown endpoint' });
    }

    // --- static UI ---
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = path.join(UI_DIR, rel);
    if (!file.startsWith(UI_DIR) || !fs.existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });

  return server;
}
