// Wiring. One process per instance, bound to one repo.
import http from 'node:http';
import { loadConfig } from './config.ts';
import { ConversationBus } from './bus.ts';
import { EventLog } from './eventlog.ts';
import { PendingStore } from './state.ts';
import { AskGate } from './askgate.ts';
import { SessionManager } from './session.ts';
import { VoiceService } from './voice.ts';
import { createServer } from './server.ts';
import { WorkIndex } from './workIndex.ts';
import { createPlansReader } from './plansReader.ts';
import { isLive } from './workItems.ts';

const cfg = loadConfig();
const bus = new ConversationBus();
const events = new EventLog(cfg.eventLogPath);
const pending = new PendingStore();

// One index, two consumers: the panel over the stream, and Beth via the `plans`
// tool. `/plans` is the built-in reader; a repo with foreign work adds its own.
const work = new WorkIndex([createPlansReader({ repo: cfg.repo, roots: cfg.planRoots })]);
work.subscribe((items) =>
  bus.publish({ type: 'work', items: items.filter((i) => isLive(i.status)), total: items.length })
);
// A spoken turn consumes pointing server-side; tell the page so its chips clear.
work.onPointingChange((refs) => bus.publish({ type: 'pointing', refs }));
work.start();

let session: SessionManager;
const gate = new AskGate(bus, events, () => session.sessionId());
session = new SessionManager(cfg, bus, events, pending, gate, work);

// Terminal-session and hook writes to the event log flow into the UI too.
events.onEvent((e) => {
  if (e.source !== 'harness') bus.publish({ type: 'event', event: e });
});
events.startTail();

const KICKOFF =
  'You just came online. In ONE short sentence, greet Danny and confirm the repo and branch you are on. Then call the say tool once (kind "status") to say you are ready. Nothing else — no status report.';

const { resumed } = session.start(process.env.HARNESS_NO_KICKOFF ? undefined : KICKOFF);

const voice = new VoiceService(cfg, bus, session);
const server = createServer({ cfg, bus, events, pending, gate, session, voice, work });
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    // Instances are per-repo, so a busy port usually means another instance.
    console.error(`Port ${cfg.port} is in use — another instance? Set HARNESS_PORT to run alongside it.`);
    process.exit(1);
  }
  throw err;
});

/**
 * TWO LISTENERS, ON PURPOSE.
 *
 * ElevenLabs must reach this process from the internet, and the tunnel that lets
 * it forwards EVERY path — so hanging the Speech Engine off the same server as
 * the UI published the whole API. `/api/state` answered strangers, and
 * `/api/turn` let anyone holding the tunnel URL talk to the director as Danny.
 *
 * So the UI and API bind to loopback, and voice gets its own port carrying
 * nothing but the websocket upgrade (which the SDK verifies against ElevenLabs'
 * JWT) plus an unauthenticated `/healthz` that reveals nothing. That port is the
 * only thing the tunnel should ever point at.
 */
const voiceServer = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not found"}');
});
voiceServer.on('error', (err: NodeJS.ErrnoException) => {
  console.error(`  voice: port ${cfg.voicePort} unavailable (${err.code}) — voice will not connect`);
});
await voice.attach(voiceServer);

server.listen(cfg.port, cfg.bind, () => {
  console.log(`director-harness → http://localhost:${cfg.port}`);
  console.log(`  repo:  ${cfg.repo}`);
  console.log(`  bind:  ${cfg.bind}${cfg.bind === '127.0.0.1' ? ' (UI and API are local-only)' : ' ⚠ REACHABLE OFF THIS MACHINE'}`);
  console.log(`  role:  ${session.role.mode} — ${session.role.reason}`);
  console.log(`  session: ${resumed ? 'resumed' : 'new'}`);
});

// Only listen publicly when voice is actually configured — otherwise nothing
// about this process is reachable from outside the machine at all.
if (voice.configured) {
  voiceServer.listen(cfg.voicePort, () => console.log(`  voice: public port ${cfg.voicePort} (websocket only)`));
}

const shutdown = () => {
  events.stop();
  work.stop();
  session.stop();
  server.close();
  voiceServer.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
