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
import type { BuildRunner } from './buildRunner.ts';
import { EFFORT_LEVELS, type EffortLevel, type HarnessConfig } from './config.ts';
import type { WorkIndex } from './workIndex.ts';
import type { WorkRef } from './workItems.ts';
import { canPromote } from './directorRole.ts';
import { SPEECH_LEVELS, type SpeechLevel } from './spoken.ts';
import { canHandOff, handOffToClaude, seedPrompt } from './handoff.ts';
import { keyterms } from './keyterms.ts';
import { Pins, workMessage } from './pins.ts';
import type { Workbench } from './workbench.ts';
import { setPlanName } from './planName.ts';
import { originAllowed } from './origin.ts';
import { EarHost } from './earHost.ts';
import { ScribeEngine } from './ear/scribeEngine.ts';
import { blobUrl, hasWeb } from './repoWeb.ts';
import { resolveImage } from './showImage.ts';
import { listPersonas } from './personas.ts';
import type { VoiceRoom } from './voiceRoom.ts';
import type { CreditMeter } from './creditMeter.ts';

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
  build: BuildRunner;
  work: WorkIndex;
  /** The repo's own vocabulary, mined once at boot — see keyterms.ts. */
  mined: string[];
  pins: Pins;
  bench: Workbench;
  /** The machine's shared mute/volume/talking-stick. See voiceRoom.ts. */
  room: VoiceRoom;
  /** The usage-credit countdown. See creditMeter.ts. */
  credits: CreditMeter;
}) {
  const { cfg, bus, events, pending, gate, session, work } = deps;

  /**
   * Whether this repo is on github.com at all — read ONCE. A remote does not
   * change under a running harness, and the page only needs to know whether to
   * draw the button; where it points is resolved per click. See repoWeb.ts.
   */
  const repoOnWeb = hasWeb(cfg.repo);

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

  // The talking stick is only worth holding when a page exists to play the
  // line — with no tabs, the greeting would otherwise silence every other
  // beth on the machine for the length of the backstop.
  deps.speakOut.setAudience(() => streams.size > 0);

  /**
   * The Scribe ear (docs/ear.md): the page streams PCM here, the harness holds
   * the recognition session. Constructed even when HARNESS_EAR is 'browser' —
   * arming is what costs, and a host that exists is one the page can be
   * offered on a later `hello` without a restart dance.
   *
   * The vocabulary deliberately ignores cfg.speechBiasing: that switch guards
   * CHROME's biasing, which is fragile enough to be opt-in. Scribe keyterms
   * are server-side, proven (the spike's with/without diff is verbatim vs
   * "Coliseus"), and the engine reports anything its limits drop.
   */
  const earHost = new EarHost({
    engine: cfg.elevenLabsApiKey
      ? new ScribeEngine({ apiKey: cfg.elevenLabsApiKey, vadSilenceSecs: cfg.earVadSilenceSecs })
      : null,
    unavailable: 'no ELEVENLABS_API_KEY — the Scribe ear needs one',
    vocabulary: () =>
      keyterms({ configured: cfg.keyterms, live: work.live().map((i) => i.spoken), mined: deps.mined }).terms,
    publish: (m) => bus.publish(m),
    usdPerHour: cfg.sttUsdPerHour,
  });

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
        director: session.directorName(),
        permissionMode: session.chosenPermissionMode(),
        speechLevel: deps.speakOut.speechLevel(),
        effort: session.chosenEffort() ?? '',
        // Draw the "open on GitHub" button, or do not. False is the ordinary
        // case for a repo with no remote, not an error.
        repoOnWeb,
        // Read per connection, not at boot: he adds a persona by dropping a file
        // in a directory, and a list fixed at startup would not have it until the
        // harness was restarted — which is the opposite of how that should feel.
        personas: listPersonas().map((p) => ({ slug: p.slug, name: p.name })),
        persona: session.persona()?.slug ?? '',
        settleMs: cfg.voiceSettleMs,
        keyterms: biasing(),
        keytermBoost: cfg.keytermBoost,
        // Which ear this harness has. 'scribe' only when it can actually be
        // armed — a page offered an ear with no key behind it gets a mic
        // button that fails on the first click, which is worse than the
        // browser path it would have had.
        ear: cfg.ear === 'scribe' && cfg.elevenLabsApiKey ? 'scribe' : 'browser',
        streamId,
      });
      send({ type: 'voice', state: 'idle', status: deps.speakOut.status() });
      // The machine's mute and volume — current state, like `pending` below,
      // and sent BEFORE the replay so the page's dials are honest by the time
      // anything could conceivably play.
      send({ type: 'room', ...deps.room.state() });
      for (const m of bus.replay()) send(m);
      // Re-render anything still waiting on a human.
      for (const a of gate.outstanding().asks) send({ type: 'ask', id: a.id, questions: a.questions });
      send({ type: 'pending', decisions: pending.openDecisions(), workers: pending.runningWorkers() });
      send({ type: 'tests', state: deps.tests.state() });
      send({ type: 'build', state: deps.build.state() });
      // Current state, not transcript — same species as `pending` and `tests`,
      // so a reconnecting page gets the bench without it riding the replay.
      send(deps.bench.message());
      // Only in-flight items go down the stream — the panel shows in-progress
      // work, and shipping all 571 of beadgame's plans on every connect is waste.
      // Plus the shelf, which is not in-flight by definition.
      send(workMessage(work, deps.pins));
      // Everything broadcasts except the instruction to make a noise.
      const unsub = bus.subscribe((m) => {
        if (m.type === 'speak' && streamId !== speakerId) return;
        // The attention half of a `show` follows the mouth for the same reason
        // `speak` does: the elected speaker is the tab Danny is looking at, and
        // "look at this" belongs on that screen, not on every monitor. The
        // figure itself still broadcasts — every transcript gets it, sans pop —
        // and a surface show is nothing BUT attention, so the others get nothing.
        if (m.type === 'show' && streamId !== speakerId) {
          if (!m.image) return;
          if (m.pop) return send({ ...m, pop: false });
        }
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
        // Every write goes through here, so this is the one place the check
        // has to live. See origin.ts for why loopback stopped being enough.
        if (!originAllowed(req.headers.origin, req.headers.host)) {
          return json(403, { error: 'cross-origin write refused' });
        }
        // Audio is the one RAW body — 250ms parcels of 16k PCM, four a second
        // while the mic is open, so it skips the JSON reader and answers
        // before the switch. Ownership is checked in earHost: a straggler
        // parcel from a tab that lost the mic drops silently.
        if (url.pathname === '/api/ear/audio') {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const buf = Buffer.concat(chunks);
          const even = buf.length - (buf.length % 2);
          earHost.audio(Number(url.searchParams.get('stream')), new Int16Array(buf.buffer, buf.byteOffset, even / 2));
          return json(200, { ok: true });
        }
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
          case '/api/voice': {
            // AUDITIONING, not choosing. Nothing is written down: the durable
            // answer to "who does she sound like" is the `voice:` line in a
            // persona file, and a picker that quietly rewrote it would edit a
            // hand-written file from a dropdown. A restart, or a persona switch,
            // puts her back to what that file says — which is the point. When he
            // likes one, the id goes in the file by hand.
            const id = String(body.voiceId ?? '');
            deps.speakOut.setVoice(id || session.persona()?.voiceId || null);
            bus.publish({ type: 'voice', state: 'idle', status: deps.speakOut.status() });
            return json(200, { ok: true, voiceId: deps.speakOut.currentVoice() });
          }
          case '/api/persona': {
            // ⚠️ This CLEARS the conversation — the system prompt is fixed when
            // the query is built, so becoming someone else means a new session.
            // The page warns before it gets here; this is not a silent restart.
            const slug = String(body.slug ?? '');
            const chosen = await session.setPersona(slug);
            if (slug && !chosen) return json(404, { error: 'no such persona' });
            return json(200, { ok: true, slug: chosen?.slug ?? '', name: session.directorName() });
          }
          case '/api/effort': {
            // How hard she thinks, chosen from the strip. Empty means the model's
            // own default, which is a real answer and not a missing one — so it
            // is accepted rather than rejected as an unknown level.
            const level = String(body.level ?? '');
            if (level && !(EFFORT_LEVELS as readonly string[]).includes(level)) {
              return json(400, { error: 'unknown level' });
            }
            await session.setEffort((level || null) as EffortLevel);
            events.append({
              source: 'harness',
              session: session.sessionId(),
              kind: 'effort',
              text: `effort → ${level || 'default'}`,
            });
            return json(200, { ok: true, level });
          }
          case '/api/speech': {
            // How much of what she writes is read aloud. Voice-side only — the
            // transcript is unaffected, which is the point of having a level.
            const level = String(body.level ?? '');
            if (!(SPEECH_LEVELS as string[]).includes(level)) return json(400, { error: 'unknown level' });
            deps.speakOut.setSpeechLevel(level as SpeechLevel);
            return json(200, { ok: true, level });
          }
          case '/api/reread': {
            // A paragraph Danny clicked to hear (again). Two deliberate
            // properties: only text the TRANSCRIPT carries is spoken — same
            // principle as /api/github, where loopback is not a reason to let a
            // request name anything it likes — and it speaks at every level
            // including `off`, because a click is an explicit request, not
            // ambience (speak() has no level gate, which is exactly right
            // here). Billing counts at stream() as always, so a re-read is
            // billed like anything else she says.
            const text = String(body.text ?? '').trim();
            if (!text) return json(400, { error: 'empty' });
            const known = bus
              .replay()
              .some((m) => (m.type === 'assistant' || m.type === 'say') && m.text.includes(text));
            if (!known) return json(404, { error: 'not in the transcript' });
            const id = deps.speakOut.speak(text);
            if (!id) return json(409, { error: 'voice unavailable' });
            return json(200, { ok: true, id });
          }
          case '/api/tests/enable': {
            // ⚠️ The one switch that lets this harness execute project code on a
            // schedule. Off by default, per repo, and the page shows the detected
            // command before offering it — a suite that spins containers or costs
            // money must not start because someone saved a file.
            deps.tests.setEnabled(Boolean(body.on));
            return json(200, { ok: true, state: deps.tests.state() });
          }
          // The build light. No enable gate and no schedule: nothing here runs
          // unless someone pressed something, which is what makes the press the
          // authorisation. See buildRunner.ts.
          case '/api/build/run': {
            void deps.build.run();
            return json(200, { ok: true, state: deps.build.state() });
          }
          case '/api/build/stop': {
            deps.build.cancel();
            return json(200, { ok: true, state: deps.build.state() });
          }
          case '/api/tests/run': {
            // Deliberate, so it ignores settle, interval and idleness. It still
            // refuses to overlap itself.
            void deps.tests.run();
            return json(200, { ok: true });
          }
          case '/api/voice/room': {
            // The whole MACHINE's mute and volume, from any tab of any beth.
            // Other harnesses hear the file change (voiceRoom.ts watches) and
            // tell their own pages; this one tells its pages right here. Mute
            // gates lines before they are announced — never fetched, never
            // billed — where volume zero still plays (and bills), quietly.
            if ('muted' in body) deps.room.setMuted(Boolean(body.muted));
            if ('volume' in body) deps.room.setVolume(Number(body.volume));
            const state = deps.room.state();
            bus.publish({ type: 'room', ...state });
            return json(200, { ok: true, ...state });
          }
          case '/api/voice/done': {
            // The page reporting playback finished — the release half of the
            // talking stick. Covers the drop paths too: a stop, a refused
            // autoplay, an element error all report, so a cut-off thought
            // frees the machine instead of holding it to the backstop.
            const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
            deps.speakOut.playbackDone(ids);
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
            // ⚠️ `duckEffort`, not `setEffort`: closing the mic restores the level
            // he CHOSE in the strip, and calling the durable setter here would
            // overwrite that choice with "default" every time he stopped talking.
            if (!cfg.voiceEffort) return json(200, { ok: true, effort: null });
            const on = Boolean(body.on);
            await session.duckEffort(on ? cfg.voiceEffort : null).catch(() => {});
            return json(200, { ok: true, effort: on ? cfg.voiceEffort : null });
          }
          case '/api/ear': {
            // Arm or release the Scribe ear for one tab. ONE ear per harness —
            // arming steals from a previous owner (earHost tells the loser) the
            // way focus claims the mouth. Effort ducking is not here: the page
            // still calls /api/listening on the same state change it always did.
            const id = Number(body.streamId);
            if (!streams.has(id)) return json(400, { ok: false, reason: 'unknown stream' });
            if (!body.on) {
              earHost.disarm(id);
              return json(200, { ok: true });
            }
            const armed = earHost.arm(id);
            return json(armed.ok ? 200 : 409, armed);
          }
          case '/api/ear/abandon': {
            // "Don't send that", by voice. The utterance lives in the Scribe
            // session, so the drop happens where the words are — the page
            // clears its composer only after this is on the wire.
            earHost.abandon(Number(body.streamId));
            return json(200, { ok: true });
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
          case '/api/pin': {
            // His own shelf, not a fact about the work — nothing is written to a
            // plan file here. See pins.ts.
            const target = String(body.path ?? '');
            if (!work.byPath(target)) return json(404, { ok: false, reason: 'no such plan' });
            const pinned = deps.pins.set(target, Boolean(body.pinned));
            bus.publish(workMessage(work, deps.pins));
            return json(200, { ok: true, pinned });
          }
          case '/api/workbench': {
            // The × on the bench, and a hand for setting it without asking her.
            // Same vetting as her tool — the page renders whatever lands here.
            if (body.url) {
              const result = deps.bench.set(String(body.url), body.label ? String(body.label) : undefined);
              if (!result.ok) return json(400, { ok: false, reason: result.reason });
              events.append({
                source: 'harness',
                session: session.sessionId(),
                kind: 'workbench',
                text: `bench → ${result.state.url}`,
              });
            } else {
              const was = deps.bench.clear();
              if (was) {
                events.append({
                  source: 'harness',
                  session: session.sessionId(),
                  kind: 'workbench',
                  text: `bench cleared — was ${was.url}`,
                });
              }
            }
            bus.publish(deps.bench.message());
            return json(200, { ok: true, bench: deps.bench.current() });
          }
          case '/api/rename': {
            // ⚠️ THE ONE WRITE. See planName.ts for why this is the exception to
            // "the harness only reads", and how narrow it is kept.
            const result = setPlanName(cfg.repo, String(body.path ?? ''), String(body.name ?? ''));
            if (!result.ok) return json(400, result);
            events.append({
              source: 'harness',
              session: session.sessionId(),
              kind: 'plan_renamed',
              text: `renamed to "${result.name}"`,
              ref: result.path,
            });
            // No republish: the work index watches the file and will see the write
            // itself. Publishing here too would race its own watcher.
            return json(200, result);
          }
          case '/api/close-worker': {
            // His hand on the same lever. A stuck worker is visible to HIM first
            // — it is his panel showing two things running and his activity dot
            // lit — so waiting to ask her to clear it is the wrong way round.
            const w = pending.closeWorker(String(body.taskId), 'cleared from the panel');
            if (!w) return json(404, { ok: false });
            events.append({
              source: 'harness',
              session: session.sessionId(),
              kind: 'worker_done',
              text: `${w.description} cleared from the panel`,
              ref: w.taskId,
            });
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
          // And the ear's half: seconds exact, dollars an estimate with the
          // assumed rate alongside. Zero for the browser ear, which is free.
          stt: earHost.spend(),
          // The credit countdown — absent unless HARNESS_CREDITS_MONTHLY is
          // set, an estimate wearing its assumptions when it is.
          credits: deps.credits.state(),
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
      if (url.pathname === '/api/wire') {
        // The wire panel PULLS while open, on a cursor. Deliberately not on the
        // bus: traffic this size in the replay would bloat every connecting tab
        // whether or not anyone ever opens the panel. See wireTap.ts.
        const since = Number(url.searchParams.get('since')) || 0;
        return json(200, session.wire.read(since));
      }
      if (url.pathname === '/api/voices') {
        // Fetched by the page after `hello` rather than shipped with it: the
        // list needs a network call to ElevenLabs, and nothing about opening a
        // conversation should wait on one. Empty is a legitimate answer.
        return json(200, { voices: await deps.speakOut.voices(), current: deps.speakOut.currentVoice() });
      }
      if (url.pathname === '/api/image') {
        // Bytes for a shown image. Same discipline as /api/github: a response
        // built from a query parameter answers only what it can PROVE — here, a
        // real image file inside the repo (showImage.ts). The CSP header is for
        // the SVG case: inside an <img> its scripts never run, but this URL can
        // be opened directly, and it is same-origin with every POST endpoint
        // above — `sandbox` makes a hostile SVG inert there too.
        const img = resolveImage(cfg.repo, url.searchParams.get('path') ?? '');
        if (!img.ok) return json(404, { error: img.reason });
        res.writeHead(200, {
          'content-type': img.mime,
          'content-security-policy': 'sandbox',
          'x-content-type-options': 'nosniff',
          // The file can change under a running session — a re-render should
          // show what the repo holds now, not what it held this morning.
          'cache-control': 'no-store',
        });
        const file = fs.createReadStream(img.abs);
        file.on('error', () => res.destroy());
        req.on('close', () => file.destroy());
        return void file.pipe(res);
      }
      if (url.pathname === '/api/github') {
        // A REDIRECT rather than a URL served with the page: the ref is read at
        // the moment of the click, and Danny switches branches mid-session — a
        // link baked into a page opened this morning would point at wherever he
        // was standing then. It also keeps the click a plain user gesture, so
        // the new tab opens before any await and nothing blocks it as a popup.
        //
        // ⚠️ Only paths the INDEX knows. This is a redirect built from a query
        // parameter, and the loopback bind is not a reason to let one name any
        // file on the machine — the index is the allowlist.
        const rel = url.searchParams.get('path') ?? '';
        if (!work.byPath(rel)) return json(404, { error: 'not a known work item' });
        const target = blobUrl(cfg.repo, rel);
        if (!target) return json(404, { error: 'no github remote' });
        res.writeHead(302, { location: target }).end();
        return;
      }
      if (url.pathname === '/api/state') {
        return json(200, {
          repo: cfg.repo,
          mode: session.role.mode,
          modeReason: session.role.reason,
          model: session.model(),
          director: session.directorName(),
          permissionMode: session.chosenPermissionMode(),
          speechLevel: deps.speakOut.speechLevel(),
          effort: session.chosenEffort() ?? '',
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
