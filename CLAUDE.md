# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

A conversational harness for a standing "director" — a long-lived Claude Agent SDK
session bound to a project repo, reachable by text or by voice. `README.md` covers how to
run it; `docs/` holds design records for work not yet built.

It is **project-agnostic on purpose**. The harness supplies the director's ROLE; the
bound repo supplies the PERSON via its own `.claude/DIRECTOR.md`. Resist anything that
teaches the harness about a specific project.

The same split holds for work: the harness defines the SHAPE of a work item
(`src/workItems.ts`) and a *reader* produces it from whatever the project stores.
`/plans` is a BUILT-IN reader because dated-markdown-with-frontmatter is Danny's
convention across repos — beadgame ships nothing. A project with foreign work (issues,
Linear) supplies its own reader. The harness only READS: the project's `/plans` and
`/tidyrepo` own where plans live and whether they are accurate, and nothing here may
write a plan file or repair frontmatter.

## Conventions

- **No build step.** Node ≥ 23 runs `.ts` directly via native type stripping. This is
  why there is no bundler, no `tsc`, and no `dist/`. Do not add one.
  ⚠️ Strip-only mode rejects **TypeScript parameter properties** (`constructor(private
  x: T)`) — declare the field and assign it.
- **No framework in the UI.** `ui/` is vanilla DOM and plain CSS. It is small enough that
  a framework would cost more than it saves.
- **Ask before adding any dependency.** Current total: the Agent SDK, zod, the ElevenLabs
  SDK and browser client, and `ws`. Each was a deliberate decision. Prefer rolling a
  small thing over taking a package.
- **Secrets never live here.** Config comes from three layers, most specific first: real
  env vars → the BOUND REPO's `.env` → `~/.director-harness/.env`. The ElevenLabs
  credentials belong in that machine file: one account and one tunnel hostname per Mac,
  so a per-repo copy duplicates a secret, and forgetting one makes the new repo silently
  text-only. See `src/config.ts` and `.env.example`. Nothing in this repo holds a key.
- **Comments explain WHY.** Several of the trickiest bits exist because of a bug that was
  expensive to find; those comments are load-bearing. Don't strip them.

## Testing

```bash
pnpm test        # node --test src/*.test.ts
```

Tests are thin and concentrated where behaviour is subtle (`audioTags`, `markdown`,
`spokenName`, the `plansReader` parsers, the `workIndex` watcher, and the turn-stream
timing in `voice.ts`, which has produced several real bugs).

⚠️ A voice test that stands a session up must set `speakable` too — `connect()` in
`voice.test.ts` does both. Setting `liveSession` alone models a session that can be
spoken through, which is exactly the belief the SDK does not share; the suite passed
green against it while the real thing was mute.

Watcher tests poll for a condition rather than sleeping a fixed amount; filesystem event
latency has no guarantee, and a fixed wait is how these go flaky.

## Running it

```bash
cd <a-project-repo> && beth        # binds to that repo, brings the tunnel up
```

Edit the code here; run `beth` from the project you want to talk about. `beth --help`
for flags.

## Hard-won gotchas

These cost hours. Don't rediscover them.

- **The SDK's bundled CLI hangs on this Mac.** Danny's default `node` is x64 under
  Rosetta, so the bundled Bun binary silently never responds ("CPU lacks AVX" on stderr
  is the only tell). Everything passes `pathToClaudeCodeExecutable` at the native arm64
  `claude`.
- **ElevenLabs dials IN to us.** Speech Engine is the websocket *client*; the harness is
  the server. `localhost` is unreachable, so voice needs a public tunnel URL ending in
  `/voice-ws`. Its absence fails **silently** — audio connects and is never heard.
- **The tunnel forwards EVERY path, so the API gets two listeners.** Hanging voice off the
  UI's server published the whole thing: `GET https://<tunnel>/api/state` answered
  strangers, and `/api/turn` let anyone with the URL talk to the director as Danny. The UI
  and API now bind to loopback (`HARNESS_BIND`); voice gets its own port
  (`HARNESS_VOICE_PORT`, default `port + 1`) carrying only the JWT-verified websocket
  upgrade and a contentless `/healthz`. **Only ever tunnel the voice port.** Anything
  added to the main server is local-only by construction — which is what makes a
  shell-executing handoff safe to build later.
- **`speechEngine.update()` ignores a top-level `wsUrl`.** It is nested under
  `speechEngine`. The bad call returns success and changes nothing, so the harness reads
  the config back and derives its listen path from what is actually stored.
- **Never wire Speech Engine's abort signal to `Query.interrupt()`.** It aborts on
  ordinary transcript revisions (partial → final), not just barge-in. Doing so kills the
  director's turn on every utterance and produces an endless re-delivery loop. Stop is a
  button, deliberately.
- **A spoken turn must never return zero chunks** — ElevenLabs re-delivers the transcript
  when it gets nothing, which restarts that same loop.
- **`onInit` hands back the SESSION, not just a conversation id** (`onInit(id, session)`).
  Taking only the id meant a session opened without anyone speaking had nothing to speak
  through — exactly the outbound-announcement case, so a long operation ended in silence.
- **`close` and `disconnected` are different endings, and you need both.** `onClose` fires
  only for an explicit protocol close message; a websocket that simply drops — what the
  browser ending a session produces — fires `onDisconnect`. Wiring only `onClose` leaves
  `liveSession` pointing at a dead session, so nothing queues, `sendResponse` throws into
  a catch, the cost meter keeps accruing, and voice effort stays pinned low for typed work.
- **ElevenLabs sends a GROWING utterance as several transcripts** while you are still
  talking, each with a new `event_id`. The SDK's model — abort the in-flight LLM call,
  start a new one — is right for a stateless completion and wrong for a long-lived
  director session, where every `session.send()` appends a user turn that cannot be
  un-sent. Acting per transcript turned one sentence into five concurrent turns talking
  over each other. `voice.ts` waits for the transcript to stop changing
  (`HARNESS_VOICE_SETTLE_MS`) and sends exactly one.
  Deferring the response is safe: the SDK leaves `inTranscriptHandler` true until the
  session closes, and `streamResponse` captures the CURRENT `event_id`, so a late
  response lands against the newest transcript — the one you want to answer.
- **The page and the ear have different budgets.** Six paragraphs of real code work
  is seconds of skimming and ninety seconds of unskippable audio, so speech takes an
  EXCERPT (`src/spoken.ts`): `say` items in full, plus the LAST PARAGRAPH of anything
  longer she writes. Positional, not clever — there is no summarising step to get
  wrong or to pay for, and the upshot is where she was already told to put it. The
  transcript is always complete; only the pronunciation is reduced. Two rules follow:
  a level that suppresses everything must still yield SOMETHING for a spoken turn
  (the last sentence — a zero-chunk response restarts the re-delivery loop), and a
  suppressed line must NOT queue as an announcement: that silence is a choice, not a
  lost line.
- **A permission card cannot be answered by voice.** `canUseTool` pends forever by
  design, so a prompt reaching the gate stops a spoken conversation dead — the paid
  channel bills while she waits and the only tell is silence, which reads as a hang.
  That is why the session runs in the SDK's `'auto'` permission mode by default
  (classifier settles the ordinary, escalates the rest) and why the card offers
  **Always**, which returns the SDK's own `suggestions` as `updatedPermissions`.
  Those suggestions are re-scoped to `'session'` on purpose: echoing them verbatim
  would write permission rules into the bound repo's settings FILE from a button
  click, durably and invisibly. `'bypassPermissions'` is never offered — it needs
  `allowDangerouslySkipPermissions` and it would delete the seam a repo's
  "production needs a per-action yes" rule depends on.
- **The director's NAME comes from the bound repo** (`directorName.ts` reads "You are
  **X**" out of `.claude/DIRECTOR.md`). It is not decoration: a card reading "Claude
  wants to use Bash" is a stranger interrupting a conversation with someone else.
  Nothing in `ui/` may hardcode it — the page learns it from `hello`.
- **A connected voice session is not a mouth.** `sendResponse()` refuses unless the SDK
  is inside a transcript handler (`inTranscriptHandler`), and that flag is set ONLY when
  ElevenLabs delivers a transcript — never at `init`. Sending outside one returns early
  with a `console.warn` and resolves happily, so flushing announcements from `onInit`
  (where they used to be flushed) emptied the queue into nothing: Beth went silent for
  the rest of the session while the page looked perfectly healthy. Speech Engine only
  lets you ANSWER something it heard. `voice.ts` tracks `speakable`, holds the queue
  until the first transcript — noise counts, "..." is a mouth — and re-queues anything
  that fails to land. Speaking first, unprompted, is a client-side "first message"
  feature, not something this side of the socket can do.
- **One response per transcript.** Every `sendResponse` ends with `is_final`, which
  closes the agent turn for that transcript, so a second response against the same one
  is at best unheard. A backlog therefore rides the next turn's stream as its opening
  chunks (`runTurn`) or goes out joined as a single response — never as N sends. There
  is ONE chain (`speakQueue`) for turns and announcements alike; two chains could
  interleave, which is the same bug wearing a different hat.
- **She writes markdown, and the page renders offsets.** File links are character RANGES
  into the message text, computed server-side, so nothing in `ui/` may transform that
  string — the offsets would move underneath. Markdown markers come off in `markdown.ts`
  BEFORE links are detected, and the formatting they carried travels as spans in the
  same coordinates. One canonical string, two overlays that cannot disagree. The voice
  path takes that string too, which is what stops TTS pronouncing asterisks.
- **Two `beth` instances break voice in a way that blames the UI.** Voice is a SINGLETON:
  one Speech Engine, one stored `wsUrl`, one tunnel hostname forwarding to one voice port.
  So ElevenLabs talks to whichever instance owns the tunnel while you may be watching the
  other's page — which looks completely healthy, because from its side nothing is wrong;
  it simply is not the harness in the conversation. Symptoms: your text appears in neither
  chat, Beth answers aloud anyway, and a plan you clicked never reaches her (the click
  POSTs to the instance that never got your turn). `beth` now refuses a second instance on
  the same repo and warns when any other is running; see `bin/beth.mjs`.
- **The ElevenLabs API-key permission is the row labelled "ElevenAgents"** (Write). There
  is no "Speech Engine" or "Conversational AI" entry. TTS/STT permissions are *not*
  needed — speech happens inside the Speech Engine session.

## Process

Small repo, one developer, usually one session. It deliberately does **not** have
beadgame's plans/claims/hooks machinery — that exists to coordinate many concurrent
sessions, which is not a problem here. Design records go in `docs/`; git history is the
rest. Add ceremony only when something actually hurts.
