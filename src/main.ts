// Wiring. One process per instance, bound to one repo.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.ts';
import { ConversationBus } from './bus.ts';
import { EventLog } from './eventlog.ts';
import { PendingStore } from './state.ts';
import { AskGate } from './askgate.ts';
import { SessionManager } from './session.ts';
import { SpeakOut } from './speakOut.ts';
import { TestMonitor } from './testRunner.ts';
import { BuildRunner } from './buildRunner.ts';
import { Settings } from './settings.ts';
import { createServer } from './server.ts';
import { WorkIndex } from './workIndex.ts';
import { createPlansReader } from './plansReader.ts';
import { InboxAcks, createInboxReader } from './inbox.ts';
import { Greetings, OnboardingOffer, kickoffPrompt, repoSnapshot, unreadPlanFiles } from './greeting.ts';
import { mineRepo, keyterms } from './keyterms.ts';
import { Pins, workMessage } from './pins.ts';
import { Workbench } from './workbench.ts';
import { Suggestion, bootSuggestion } from './suggestion.ts';
import { ensurePersonasDir } from './personas.ts';
import { VoiceRoom } from './voiceRoom.ts';
import { CreditMeter, anyWindowExhausted } from './creditMeter.ts';
import { StatusLine } from './statusLine.ts';

// The harness runs ON node, but the PATH it inherited may not carry one — beth
// launched outside an interactive shell (nvm lives in .zshrc) hands us a PATH
// where every child that shebangs `#!/usr/bin/env node` (pnpm's shims, npm
// bins) dies with `env: node: No such file or directory`. The test runner is
// where that surfaced, but the director's own shell commands inherit the same
// PATH. Add the node that is provably here — ours — and only when none is on
// the PATH already, so a deliberately-chosen node keeps winning.
const pathHasNode = (process.env.PATH ?? '')
  .split(path.delimiter)
  .some((d) => d && fs.existsSync(path.join(d, 'node')));
if (!pathHasNode) {
  process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`;
}

const cfg = loadConfig();
// Machine-side, beside the .env. Created empty on first boot with a README —
// an empty directory next to the secrets is the only hint personas exist.
ensurePersonasDir();
const bus = new ConversationBus();

// The terminal's bottom line — `beth: <repo>`, spinning while a turn runs.
// Installed before anything logs so every later line lands above it; shown
// only after the boot summary, so that summary reads as plain output. Rides
// the same `status` messages the page's dot does: `thinking` is a turn in
// flight, anything else is not.
const statusLine = new StatusLine({ label: path.basename(cfg.repo) });
statusLine.install();
bus.subscribe((m) => {
  if (m.type === 'status') statusLine.setBusy(m.state === 'thinking');
});
const events = new EventLog(cfg.eventLogPath);
const pending = new PendingStore();

// One index, two consumers: the panel over the stream, and Beth via the `plans`
// tool. `/plans` is the built-in reader; a repo with foreign work adds its own.
// The inbox: hand-offs other agents and apps wrote to a file (docs/inbox.md).
// The acks are hers, in the state dir; the producer's file is only ever read.
const inbox = new InboxAcks(cfg);
// Who she is, read at READ time rather than captured: the session (and the
// persona it restores) is built after the index, and a persona switch changes
// the name mid-run. Until the session exists, the repo's own director.
let directorNow: () => string = () => cfg.directorName;
const work = new WorkIndex(
  [
    createPlansReader({ repo: cfg.repo, roots: cfg.planRoots }),
    createInboxReader({ dir: cfg.inboxDir, files: cfg.inboxFiles, director: () => directorNow(), acks: inbox }),
  ],
  {
    // The director plan is the role LOCK, not work. Held out of the board so it
    // stops occupying a permanent slot in ACTIVE and inflating the count.
    roleLockPath: cfg.directorPlan,
  }
);
const pins = new Pins(cfg);
// The url being iterated on, if the last run pinned one — same shelf-life
// reasoning as pins: the dev server it points at usually outlives the harness.
const bench = new Workbench(cfg);
// The ghost reply in the composer. In memory only: it answers the last thing
// she said, and a restart has nothing for it to answer.
const suggestion = new Suggestion();
// One builder for all three publishers (here, `hello`, and the pin endpoint), so
// the shelf cannot be present on one and missing on another.
work.subscribe(() => bus.publish(workMessage(work, pins)));
// A spoken turn consumes pointing server-side; tell the page so its chips clear.
work.onPointingChange((refs) => bus.publish({ type: 'pointing', refs }));
work.start();

// The MACHINE's voice room — several beths on one Mac take turns (the talking
// stick), and share one mute and one volume. See voiceRoom.ts.
const room = new VoiceRoom();
// Another harness flipping the mute or the volume arrives as a file change;
// the pages learn about it like any other state.
room.watch((s) => bus.publish({ type: 'room', ...s }));

// The speech plane, entire. No Speech Engine, no tunnel, no public port, no
// session and no mic required to speak — she says a line because she wrote one.
// Built BEFORE the session because the session hands her the dial: "stop talking"
// is said out loud, to her, and she needs a way to actually do it.
const speakOut = new SpeakOut(cfg, bus, room);

let session: SessionManager;
const gate = new AskGate(bus, events, () => session.sessionId(), () => session.directorName());
session = new SessionManager(
  cfg,
  bus,
  events,
  pending,
  gate,
  work,
  {
    level: speakOut.speechLevel,
    set: (level) => speakOut.setSpeechLevel(level),
    setVoice: speakOut.setVoice,
  },
  bench,
  suggestion,
  inbox
);
// A persona chosen on a previous run speaks in her own voice from the first line
// of the greeting, not from the first switch.
speakOut.setVoice(session.persona()?.voiceId ?? null);
// ...and reads her own inbox from the first read. The boot read above ran under
// the repo's name; if a persona is in the room, re-address it now, and again
// whenever the room changes hands.
directorNow = () => session.persona()?.name ?? cfg.directorName;
if (session.persona()) work.refresh();
bus.subscribe((m) => {
  if (m.type === 'persona') work.refresh();
});

// A hand-off ARRIVING is a summons — spoken, and a line in the transcript —
// exactly once. ⚠️ The seen-set is seeded from what is already there, so a
// restart does not read him the whole backlog: the same trap `speakOut`'s
// decision announcements walk around, closed one step earlier here by never
// publishing an event for the backlog at all. Acknowledged items are seeded
// too, so reopening one from the panel is not an arrival.
const seenHandoffs = new Set(work.all().filter((i) => i.inbox).map((i) => i.path));
work.subscribe((items) => {
  for (const i of items) {
    if (!i.inbox || seenHandoffs.has(i.path)) continue;
    seenHandoffs.add(i.path);
    if (i.inbox.ack) continue;
    const text = `${i.inbox.from}: ${i.title}`;
    // Harness-written events are not echoed off the tail (below), so this one
    // is published by hand — it is the message speakOut speaks.
    const event = events.append({ source: 'harness', session: session.sessionId(), kind: 'handoff', text, ref: i.path });
    bus.publish({ type: 'event', event });
    // The summons above reaches Danny; this is how it reaches HER — on his
    // next turn, never as one of her own.
    session.noteArrival(i.path);
  }
});

// Terminal-session and hook writes to the event log flow into the UI too.
events.onEvent((e) => {
  if (e.source !== 'harness') bus.publish({ type: 'event', event: e });
});
events.startTail();

// What she opened with the last few times, so this time can be different. See
// greeting.ts: the boot line was always hers to write, but a fresh session cannot
// know it has a habit, and identical inputs produce an identical sentence.
// Keyed by persona as well as repo: two directors sharing a project should not
// be avoiding each other's opening lines.
const greetings = new Greetings(cfg, session.persona()?.slug ?? '');
// The boot greeting is one of exactly two moments a personal beat may ride —
// it is already hers, and it is one sentence he is going to hear anyway. Most
// days this returns nothing, which is correct. Called either way, so suppressing
// the greeting does not silently bank a follow-up for a turn that never happens.
const beat = session.personal.beat();
// A repo that is not set up for the harness gets ONE offer of /director-skills,
// with evidence, folded into the greeting. Once ever: the mark is written when
// the offer rides, so declining it is durable. See docs/director-skills.md.
const onboardOffer = new OnboardingOffer(cfg);
const hasGuide = fs.existsSync(path.join(cfg.repo, '.claude', 'DIRECTOR.md'));
const unread = unreadPlanFiles(cfg.repo, work.all().length);
const onboarding =
  !onboardOffer.offered() && (!hasGuide || unread) ? { noGuide: !hasGuide, unreadPlans: unread } : undefined;
if (onboarding) onboardOffer.markOffered();
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
        onboarding,
      }),
      beat,
    ]
      .filter(Boolean)
      .join('\n\n');
// The first reply is the one reply that is always obvious, and there is no turn
// she could have offered it in — so the harness puts it in the composer itself,
// as the reply to the greeting about to be written. Only when there IS one: see
// Suggestion.seed for why an opening line under his own first sentence is worse
// than none. Her name, not the harness's — a ghost line addressing a stranger
// is the same mistake as a permission card that says "Claude".
if (kickoff) suggestion.seed(bootSuggestion(session.directorName()));
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

// The credit countdown — armed only while a plan window is exhausted, because
// that is when usage credits actually drain. Rides the same usage snapshots
// the page renders, so a turn is counted exactly once, where its cost lands.
const credits = new CreditMeter({
  monthlyUsd: cfg.creditsMonthlyUsd,
  resetDay: cfg.creditsResetDay,
  repo: path.basename(cfg.repo),
  exhausted: async () => anyWindowExhausted(await session.planUsage()),
});
bus.subscribe((m) => {
  if (m.type === 'usage' && m.usage.turnCost > 0) void credits.noteTurn(m.usage.turnCost);
});

// Set from the page and kept in the state dir, winning over the env layers —
// see settings.ts for why that way round.
const settings = new Settings(cfg);
const tests = new TestMonitor(cfg, bus, settings);
const build = new BuildRunner(cfg, bus, { settings });
// The repo's own nouns, walked ONCE — the page gets this plus whatever is live on
// the board. Mined even when biasing is off, because the count is worth printing:
// it is how you find out the list is empty before wondering why nothing improved.
const mined = mineRepo(cfg.repo);
const server = createServer({ cfg, bus, events, pending, gate, session, speakOut, tests, build, settings, work, mined, pins, inbox, bench, suggestion, room, credits });
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
  console.log(`beth → http://localhost:${cfg.port}`);
  console.log(`  repo:  ${cfg.repo}`);
  console.log(`  bind:  ${cfg.bind}${cfg.bind === '127.0.0.1' ? ' (local-only, all of it)' : ' ⚠ REACHABLE OFF THIS MACHINE'}`);
  console.log(`  role:  ${session.role.mode} — ${session.role.reason}`);
  console.log(`  who:   ${session.directorName()} · permissions ${session.chosenPermissionMode()}`);
  console.log(`  session: ${resumed ? 'resumed' : 'new'}`);
  tests.start();
  build.start();
  console.log(`  voice: ${speakOut.configured ? `${cfg.ttsModel}, browser ear — nothing billed idle` : `text-only — ${speakOut.unavailableReason}`}`);
  // No silent caps: say how many terms are in play and how many fell off the end,
  // because a list that is quietly empty looks exactly like biasing that does not
  // work. Off is stated too — it is off by default and that surprises people.
  if (cfg.speechBiasing) {
    const { terms, dropped } = keyterms({ configured: cfg.keyterms, live: work.live().map((i) => i.spoken), mined });
    console.log(
      `  terms: ${terms.length} biased at ×${cfg.keytermBoost} (${cfg.keyterms.length} yours, ${mined.length} from the repo)${dropped ? ` — ${dropped} over the cap, dropped` : ''}`
    );
  } else {
    console.log(`  terms: biasing off — ${mined.length} nouns available, HARNESS_SPEECH_BIASING=on to use them`);
  }
  statusLine.show();
});

const shutdown = () => {
  // First, so the line is gone before anything below prints a farewell.
  statusLine.stop();
  events.stop();
  work.stop();
  tests.stop();
  build.stop();
  session.stop();
  // Frees a held talking stick on the way out — the other beths should not
  // have to wait out the TTL because this one exited cleanly.
  room.close();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
