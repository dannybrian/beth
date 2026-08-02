// Wiring. One process per instance, bound to one repo.
import path from 'node:path';
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
import { Greetings, kickoffPrompt, repoSnapshot } from './greeting.ts';
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

// The speech plane, entire. No Speech Engine, no tunnel, no public port, no
// session and no mic required to speak — she says a line because she wrote one.
// Built BEFORE the session because the session hands her the dial: "stop talking"
// is said out loud, to her, and she needs a way to actually do it.
const speakOut = new SpeakOut(cfg, bus);

let session: SessionManager;
const gate = new AskGate(bus, events, () => session.sessionId(), cfg.directorName);
session = new SessionManager(cfg, bus, events, pending, gate, work, {
  level: speakOut.speechLevel,
  set: (level) => speakOut.setSpeechLevel(level),
});

// Terminal-session and hook writes to the event log flow into the UI too.
events.onEvent((e) => {
  if (e.source !== 'harness') bus.publish({ type: 'event', event: e });
});
events.startTail();

// What she opened with the last few times, so this time can be different. See
// greeting.ts: the boot line was always hers to write, but a fresh session cannot
// know it has a habit, and identical inputs produce an identical sentence.
const greetings = new Greetings(cfg);
// The boot greeting is one of exactly two moments a personal beat may ride —
// it is already hers, and it is one sentence he is going to hear anyway. Most
// days this returns nothing, which is correct. Called either way, so suppressing
// the greeting does not silently bank a follow-up for a turn that never happens.
const beat = session.personal.beat();
const kickoff = process.env.HARNESS_NO_KICKOFF
  ? undefined
  : [
      kickoffPrompt({
        repoName: path.basename(cfg.repo),
        snapshot: repoSnapshot(cfg.repo),
        // The index is already loaded — the same live set the panel renders.
        live: work.live(),
        priors: greetings.recent(),
        lastAt: greetings.lastAt(),
      }),
      beat,
    ]
      .filter(Boolean)
      .join('\n\n');
const { resumed } = session.start(kickoff);

// Remember what she actually said, which is the only input that makes the NEXT
// boot different. First assistant message only, and only when we asked for one:
// without a kickoff the first message answers a real turn and is not an opening.
if (kickoff) {
  const unsub = bus.subscribe((m) => {
    if (m.type !== 'assistant') return;
    greetings.record(m.text);
    unsub();
  });
}

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
