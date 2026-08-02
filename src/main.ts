// Wiring. One process per instance, bound to one repo.
import { loadConfig } from './config.ts';
import { ConversationBus } from './bus.ts';
import { EventLog } from './eventlog.ts';
import { PendingStore } from './state.ts';
import { AskGate } from './askgate.ts';
import { SessionManager } from './session.ts';
import { SpeakOut } from './speakOut.ts';
import { TestMonitor } from './testRunner.ts';
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
const work = new WorkIndex([createPlansReader({ repo: cfg.repo, roots: cfg.planRoots })], {
  // The director plan is the role LOCK, not work. Held out of the board so it
  // stops occupying a permanent slot in ACTIVE and inflating the count.
  roleLockPath: cfg.directorPlan,
});
work.subscribe((items) =>
  bus.publish({ type: 'work', items: items.filter((i) => isLive(i.status) && !i.roleLock), total: items.length })
);
// A spoken turn consumes pointing server-side; tell the page so its chips clear.
work.onPointingChange((refs) => bus.publish({ type: 'pointing', refs }));
work.start();

let session: SessionManager;
const gate = new AskGate(bus, events, () => session.sessionId(), cfg.directorName);
session = new SessionManager(cfg, bus, events, pending, gate, work);

// Terminal-session and hook writes to the event log flow into the UI too.
events.onEvent((e) => {
  if (e.source !== 'harness') bus.publish({ type: 'event', event: e });
});
events.startTail();

/**
 * ONE line, and one carrier for it.
 *
 * This used to ask for a greeting AND a `say` item, because a `say` is spoken in
 * full while an ordinary reply is excerpted — the second call was how you made
 * sure the first was heard. Speak-out removed that reason and exposed the cost:
 * both lines now reach the speakers, so booting said the same thing three times
 * ("I'm on Tulito, branch main" · "Beth is online and ready" · "Ready when you
 * are"). The fix is not a filter, it is asking for one line.
 */
const KICKOFF =
  'You just came online. Greet Danny in ONE short sentence naming the repo and branch — that sentence is the whole of it. Do not call the say tool, do not add a status report, and do not add a closing line: everything you write here is read aloud, so a second line that repeats the first is simply heard twice.';

// The boot greeting is one of exactly two moments a personal beat may ride —
// it is already hers, and it is one sentence he is going to hear anyway. Most
// days this returns nothing, which is correct.
const beat = session.personal.beat();
const { resumed } = session.start(
  process.env.HARNESS_NO_KICKOFF ? undefined : beat ? `${KICKOFF}\n\n${beat}` : KICKOFF
);

// The speech plane, entire. No Speech Engine, no tunnel, no public port, no
// session and no mic required to speak — she says a line because she wrote one.
const speakOut = new SpeakOut(cfg, bus);
const tests = new TestMonitor(cfg, bus);
const server = createServer({ cfg, bus, events, pending, gate, session, speakOut, tests, work });
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    // Instances are per-repo, so a busy port usually means another instance.
    console.error(`Port ${cfg.port} is in use — another instance? Set HARNESS_PORT to run alongside it.`);
    process.exit(1);
  }
  throw err;
});

/**
 * ONE LISTENER, on loopback.
 *
 * There used to be two. ElevenLabs dialled IN to us, the tunnel that allowed it
 * forwarded every path, and hanging voice off the UI's server published the whole
 * API — `/api/state` answered strangers and `/api/turn` let anyone holding the URL
 * talk to the director as Danny. The fix was a second port carrying only a
 * JWT-verified websocket upgrade, and a standing rule to tunnel nothing else.
 *
 * Recognition now happens in the browser and her audio is streamed over loopback,
 * so nothing dials in and the second port has nothing to carry. What that buys is
 * bigger than the deletion: every byte of this harness is unreachable from off
 * this machine by construction, which is what makes a shell-executing handoff
 * safe to have at all.
 */
server.listen(cfg.port, cfg.bind, () => {
  console.log(`director-harness → http://localhost:${cfg.port}`);
  console.log(`  repo:  ${cfg.repo}`);
  console.log(`  bind:  ${cfg.bind}${cfg.bind === '127.0.0.1' ? ' (local-only, all of it)' : ' ⚠ REACHABLE OFF THIS MACHINE'}`);
  console.log(`  role:  ${session.role.mode} — ${session.role.reason}`);
  console.log(`  who:   ${cfg.directorName} · permissions ${session.chosenPermissionMode()}`);
  console.log(`  session: ${resumed ? 'resumed' : 'new'}`);
  tests.start();
  console.log(`  voice: ${speakOut.configured ? `${cfg.ttsModel}, browser ear — nothing billed idle` : `text-only — ${speakOut.unavailableReason}`}`);
});

const shutdown = () => {
  events.stop();
  work.stop();
  tests.stop();
  session.stop();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
