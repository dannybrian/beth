// WebServer — serves the UI and carries the conversation to the browser.
//
// Transport is Server-Sent Events (server→browser) + POST (browser→server)
// rather than a websocket: Node has no built-in websocket SERVER, and the plan
// treats transport as incidental. SSE is zero-dependency and reconnects on its
// own. Phase 2 can swap in a real socket if audio needs bidirectional framing.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConversationBus, UIMessage } from './bus.ts';
import type { EventLog } from './eventlog.ts';
import type { PendingStore } from './state.ts';
import type { AskGate } from './askgate.ts';
import type { SessionManager } from './session.ts';
import type { VoiceService } from './voice.ts';
import type { HarnessConfig } from './config.ts';
import type { WorkIndex } from './workIndex.ts';
import type { WorkRef } from './workItems.ts';
import { canPromote } from './directorRole.ts';
import { canHandOff, handOffToClaude, seedPrompt } from './handoff.ts';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

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
  voice: VoiceService;
  work: WorkIndex;
}) {
  const { cfg, bus, events, pending, gate, session, work } = deps;

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
      const send = (m: UIMessage) => res.write(`data: ${JSON.stringify(m)}\n\n`);
      send({
        type: 'hello',
        repo: cfg.repo,
        mode: session.role.mode,
        modeReason: session.role.reason,
        model: session.chosenModel(),
      });
      send({ type: 'voice', state: deps.voice.status().connected ? 'connected' : 'idle', status: deps.voice.status() });
      for (const m of bus.replay()) send(m);
      // Re-render anything still waiting on a human.
      for (const a of gate.outstanding().asks) send({ type: 'ask', id: a.id, questions: a.questions });
      send({ type: 'pending', decisions: pending.openDecisions(), workers: pending.runningWorkers() });
      // Only in-flight items go down the stream — the panel shows in-progress
      // work, and shipping all 571 of beadgame's plans on every connect is waste.
      send({ type: 'work', items: work.live(), total: work.all().length });
      const unsub = bus.subscribe(send);
      const keepalive = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => {
        clearInterval(keepalive);
        unsub();
      });
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
            const ok = gate.answerApproval(String(body.id), Boolean(body.allowed));
            return json(ok ? 200 : 404, { ok });
          }
          case '/api/model': {
            const model = String(body.model ?? '').trim();
            if (!model) return json(400, { error: 'no model' });
            await session.setModel(model);
            return json(200, { ok: true, model });
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
      if (url.pathname === '/api/voice/token') {
        // Short-lived browser token. The API key never leaves this process.
        return json(200, await deps.voice.mintToken());
      }
      if (url.pathname === '/api/voice/status') {
        return json(200, deps.voice.status());
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
          sessionId: session.sessionId(),
          decisions: pending.allDecisions(),
          workers: pending.allWorkers(),
          events: events.recent(30),
        });
      }
      return json(404, { error: 'unknown endpoint' });
    }

    // --- vendored browser client ---
    // @elevenlabs/client ships a self-contained IIFE (global `ElevenLabsClient`),
    // so it can be served straight from node_modules — no bundler, no CDN.
    if (url.pathname === '/vendor/elevenlabs.js') {
      const bundle = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'node_modules',
        '@elevenlabs',
        'client',
        'dist',
        'lib.iife.js'
      );
      if (!fs.existsSync(bundle)) {
        res.writeHead(404).end('// @elevenlabs/client not installed');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'max-age=3600' });
      res.end(fs.readFileSync(bundle));
      return;
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
