// Wiring. One process per instance, bound to one repo.
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
import { isInFlight } from './workItems.ts';

const cfg = loadConfig();
const bus = new ConversationBus();
const events = new EventLog(cfg.eventLogPath);
const pending = new PendingStore();

// One index, two consumers: the panel over the stream, and Beth via the `plans`
// tool. `/plans` is the built-in reader; a repo with foreign work adds its own.
const work = new WorkIndex([createPlansReader({ repo: cfg.repo, roots: cfg.planRoots })]);
work.subscribe((items) => bus.publish({ type: 'work', items: items.filter((i) => isInFlight(i.status)) }));
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
// Speech Engine attaches to the same HTTP server, on its own path.
await voice.attach(server);

server.listen(cfg.port, () => {
  console.log(`director-harness → http://localhost:${cfg.port}`);
  console.log(`  repo:  ${cfg.repo}`);
  console.log(`  role:  ${session.role.mode} — ${session.role.reason}`);
  console.log(`  session: ${resumed ? 'resumed' : 'new'}`);
});

const shutdown = () => {
  events.stop();
  work.stop();
  session.stop();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
