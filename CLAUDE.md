# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

A conversational harness for a standing "director" — a long-lived Claude Agent SDK
session bound to a project repo, reachable by text or by voice. `README.md` covers how to
run it; `docs/` holds design records for work not yet built.

It is **project-agnostic on purpose**. The harness supplies the director's ROLE; the
bound repo supplies the PERSON via its own `.claude/DIRECTOR.md`. Resist anything that
teaches the harness about a specific project.

Since 2026-08-06 there is a THIRD place a person can come from, and it is neither of
those: `~/.director-harness/personas/*.md` on the machine (`src/personas.ts`). A persona
is Danny's, not a project's and not the harness's — checking one in here would mean
editing the tool to hire a colleague, which is the same mistake one level over. The
harness ships none, exactly as it ships no plans, and a machine with no personas behaves
precisely as it did before. Persona and `DIRECTOR.md` COMPOSE: the persona says who she
is, the repo says what this project needs from a director, and the repo's guide comes
second because it is the more specific instruction.

`skills/director-skills/` is the repo-side half of the contract made executable: a
machine-installed skill (symlinked to `~/.claude/skills/`) that diagnoses a repo against
the contract and bootstraps the missing half — format from vendored templates, person by
interview. `docs/director-skills.md` is the record. ⚠ The vendored `/plans` CLI under
`templates/` is a SNAPSHOT that bootstrapped repos own; two of its tests fail when run
IN PLACE here (they resolve the repo root four dirs up, which is only true after copying
into a real `.claude/skills/plans/`) and pass 94/94 from a bootstrapped location. This
repo itself has a `.claude/DIRECTOR.md` (Wren — the interview's worked example) but
deliberately NO plans machinery, per Process below.

The same split holds for work: the harness defines the SHAPE of a work item
(`src/workItems.ts`) and a *reader* produces it from whatever the project stores.
`/plans` is a BUILT-IN reader because dated-markdown-with-frontmatter is Danny's
convention across repos — beadgame ships nothing. A project with foreign work (issues,
Linear) supplies its own reader. The harness only READS: the project's `/plans` and
`/tidyrepo` own where plans live and whether they are accurate, and nothing here may
write a plan file or repair frontmatter.

⚠️ ONE exception, and it is narrow on purpose: `src/planName.ts` writes a plan's `name:`
key when Danny renames it from the panel — the affordance `workItems.ts` always
anticipated ("a future rename affordance has somewhere to write to"). It touches that one
key, leaves every other byte alone, and REFUSES a plan with no frontmatter rather than
creating one, because creating a block is exactly the repair the rule forbids and it
belongs to `/tidyrepo`. Do not add a second writer without an argument this specific.
Pins (`src/pins.ts`) are NOT an exception — a pin is one person's attention on one
machine, so it lives in the state dir and no plan file learns about it.

## Conventions

- **No build step.** Node ≥ 23 runs `.ts` directly via native type stripping. This is
  why there is no bundler, no `tsc`, and no `dist/`. Do not add one.
  ⚠️ Strip-only mode rejects **TypeScript parameter properties** (`constructor(private
  x: T)`) — declare the field and assign it.
- **No framework in the UI.** `ui/` is vanilla DOM and plain CSS. It is small enough that
  a framework would cost more than it saves. It is ONE loom (`app.js` — the handler map,
  composer, panels, shared state) plus native ES modules for the seams whose bookkeeping
  fails invisibly: `listen.js`, `speaker.js`, `wire.js` — each testable from node with a
  stub where the browser object would be, no build step involved. The criterion for
  extracting a module is that testability, never line count.
- **Ask before adding any dependency.** Current total: the Agent SDK, zod, and the
  ElevenLabs SDK (for TTS, nothing else). Each was a deliberate decision. Prefer rolling
  a small thing over taking a package. The browser client and `ws` both left with the
  dial-in path, which is what a good deletion looks like.
- **Secrets never live here.** Config comes from three layers, most specific first: real
  env vars → the BOUND REPO's `.env` → `~/.director-harness/.env`. The ElevenLabs
  credentials belong in that machine file: one account per Mac, so a per-repo copy
  duplicates a secret, and forgetting one makes the new repo silently text-only. See `src/config.ts` and `.env.example`. Nothing in this repo holds a key.
  ⚠ Since 2026-08-31 there is a FOURTH source and it is the only one that is
  written: `src/settings.ts`, the gear panel's store, in the per-repo state dir
  beside `tests.json`. It WINS over all three — deliberately, because a value
  typed into the page that silently lost to a repo `.env` would be a no-op with
  no symptom, and the panel says which layer won instead. Only what a page can
  set belongs there; secrets stay in the `.env` layers, where they are not one
  click from being rewritten.
- **Comments explain WHY.** Several of the trickiest bits exist because of a bug that was
  expensive to find; those comments are load-bearing. Don't strip them.

## Testing

```bash
pnpm test        # node --test src/*.test.ts
```

Tests are thin and concentrated where behaviour is subtle (`audioTags`, `markdown`,
`spokenName`, the `plansReader` parsers, the `workIndex` watcher, `mouth` — the speech-out
core, billing included — and `speakOut`, its bus adapter (⚠ whose `setVoice`/`speechLevel`
are passed around DETACHED by main.ts, so they stay arrow properties; the test pins it), the `testRunner` detectors and failure parsers, `settings` (the write layer: that
what the page set beats the env layer, that clearing hands the command back, and
that changing a command drops the light the OLD one earned — a green kept across
that change reads exactly like the new command having passed), `buildRunner` (the other half of
that contract: detection that must REFUSE a dev server, a stop that is not a
failure, and a staleness watch that stops once it fires — a light claiming green
after an edit is the same lie the test light's yellow exists to avoid),
and `listen`, which drives a STUBBED `SpeechRecognition` so the seams Chrome creates can be
tested at all; `speaker` (the playback queue against a stubbed `<audio>` — a wedged queue
looks like her going quiet, a deliberate stop reported as an error looks like a bug) and
`wire` (the panel's anatomy/token math, which renders plausibly WRONG rather than failing)
follow the same pattern — as does `title` (the tab badge: a summons that never appears
leaves a session stopped at a card looking like a hang, and one that sticks after the
answer teaches the eye to stop reading the tab. ⚠ Liveness is a FLAG, never
`askCards.size` — answered asks STAY in that map, because the dedup on render is what
stops a replay rebuilding a settled card), and `paste` (handing her a failure or a log
verbatim — a fence its own contents can break spills the log into prose, where a line of
build output reads as something Danny asked for; the inline-code case is the same bug one
level up and was found by RUNNING it, not reading it, when a `-e` command quoting a symbol
ended its own span), and `md` (the plan reader's parse — a mis-parse renders
confident, well-formed and WRONG: a checklist that loses its boxes, a table read as
prose, a fenced block whose contents escape into headings. Nothing throws). Browser code is testable when the hard part is bookkeeping rather
than the browser.

The rest earn their tests by being places a mistake is INVISIBLE: `toolInput` (a malformed
call recovered from the real payload), `planName` (the one writer — that it round-trips
through the real reader, and that nothing else in the file moves), `pins` (that a shelved
plan survives a restart and still shows when it is not in flight), `state` (a worker
leaving the roster when nothing will ever report it), `keyterms`, `greeting`, and
`stylesheet`, which exists because a stray `*/` drops CSS rules with no error anywhere,
`sendPointed` (harness scaffolding rendered as words Danny typed), `personas`, `showImage` (the
/api/image allowlist — a wrong refusal is a broken figure, a wrong acceptance is a
query string reading files off the machine), `workbench` (the bench-url vetting —
the page hands it straight to an `<a href>` in every open tab, so a `javascript:`
url pinned by a confused tool call would be an executable link in the boldest spot
on the page; and `localhost:3000` parses with scheme `localhost:`, so the most
natural input of all was refused until the retry-as-http), `bus` (the `show` replay split — a pop
that replayed would re-open the lightbox on every reconnect, which looks exactly
like the feature working until the first mid-conversation reload), and the greeting's
onboarding offer (a nag if it repeats, silently absent if it never fires). The Scribe
ear added four more in the same two shapes: `ear/pcm` (a resampler that drifts or
warbles at chunk seams doesn't error — she just mishears him), `ear/scribeEngine`
(driven by REAL captured frames from `src/ear/fixtures/`, including a live
`auth_error` and the fatal oversized-keyterm `invalid_request`), `earHost` (two armed
tabs would be two paid sessions; spend counted on parked audio), and `remoteEar`
(off() sending what it held, a steal leaving a mic that looks live). `voiceRoom` and the
room half of `speakOut` follow: a stick nobody can break is a beth who went quiet for no
reason, a wrong steal cuts a live sentence, and a page ending a line without reporting it
(`speaker`'s report tests) holds every other harness mute with no symptom here.
`creditMeter` too: cycle math that drifts a day reads as a refund, and a meter counting
plan-covered turns bills money never drawn.

⚠️ A test-output fixture you INVENTED is worth very little. The node-`--test` fixture here
passed green while real output produced three entries for one failure, because real output
names each failure twice and the invented one did not. Paste real output.

Watcher tests poll for a condition rather than sleeping a fixed amount; filesystem event
latency has no guarantee, and a fixed wait is how these go flaky.

## Running it

```bash
cd <a-project-repo> && beth        # binds to that repo, opens a browser
```

Edit the code here; run `beth` from the project you want to talk about. `beth --help`
for flags.

## Hard-won gotchas

These cost hours. Don't rediscover them.

- **The SDK's bundled CLI hangs on this Mac.** Danny's default `node` is x64 under
  Rosetta, so the bundled Bun binary silently never responds ("CPU lacks AVX" on stderr
  is the only tell). Everything passes `pathToClaudeCodeExecutable` at the native arm64
  `claude`.
- **Nothing dials in any more, and that is the security story.** Speech Engine used to
  be the websocket CLIENT — we were the server — so voice needed a public tunnel URL, a
  second listener, a JWT-verified upgrade path, and a standing rule that only the voice
  port may ever be tunnelled. All of it is gone: the browser listens (`ui/listen.js`) and
  her audio streams over loopback (`src/speakOut.ts`). ONE listener, bound to 127.0.0.1,
  carrying everything. That is what makes the shell-executing handoff safe by
  construction rather than by rule.
  ⚠ Do not reintroduce a public listener without re-reading `docs/voice-plane.md`. The
  bugs it cost were expensive and none of them named themselves: `/api/state` answering
  strangers, `/api/turn` letting anyone with the URL talk to the director as Danny, and a
  4621 collision that broke voice while pointing at everything except the port.
- **The page and the ear have different budgets.** Six paragraphs of real code work
  is seconds of skimming and ninety seconds of unskippable audio, so speech takes an
  EXCERPT (`src/spoken.ts`): `say` items in full, plus the LAST PARAGRAPH of anything
  longer she writes. Positional, not clever — there is no summarising step to get
  wrong or to pay for, and the upshot is where she was already told to put it. The
  transcript is always complete; only the pronunciation is reduced.
  Silence is now genuinely silent: `off` speaks nothing and queues nothing. The old
  rule that a suppressed turn must still yield SOMETHING existed only because a
  zero-chunk response made ElevenLabs re-deliver the transcript, and nothing
  re-delivers anything now.
  ⚠ The corollary bites in the other direction: EVERYTHING she writes is heard, so a
  prompt that asks for the same thing twice is heard twice. That is what made booting
  say "I am here" three times — see the kickoff note in `greeting.ts`, which is where
  the boot line is assembled now.
- **A greeting with nothing to be specific about is the same greeting every day.** Hers
  was model-written from the start and still came out word-for-word identical for weeks,
  because every boot handed her the same inputs and told her what to put in it, and no
  session can remember what the last one said. `greeting.ts` fixes the two halves: the
  last six openings ride the prompt as "not these", and the facts that actually differ
  (branch, dirt, last commit, in-flight, the clock, the gap since she was last up) ride
  it as material. ⚠ Do not add a second thing to the boot prompt to make it richer —
  richness comes from the material, and asking for two things is what made it speak
  three times. It stays ONE sentence.
  The level is HERS to change as well as Danny's (`speech` tool in `tools.ts`, the same
  dial `/api/speech` turns), because "stop talking" is said out loud to the person
  talking, not clicked. ⚠ The change lands the moment the call does, and the level is
  read when a message is PUBLISHED — so an ack written in the same message as the call
  is spoken at the OLD level, and one written after the tool result at the NEW one. That
  is the right way round in both directions, and it is why the tool description says
  which way to write it rather than leaving it to luck.
- **A permission card cannot be answered by voice.** `canUseTool` pends forever by
  design, so a prompt reaching the gate stops a spoken conversation dead, and the only
  tell is silence, which reads as a hang.
  That is why the session runs in the SDK's `'auto'` permission mode by default
  (classifier settles the ordinary, escalates the rest) and why the card offers
  **Always**, which returns the SDK's own `suggestions` as `updatedPermissions`.
  Those suggestions are re-scoped to `'session'` on purpose: echoing them verbatim
  would write permission rules into the bound repo's settings FILE from a button
  click, durably and invisibly. `'bypassPermissions'` is never offered — it needs
  `allowDangerouslySkipPermissions` and it would delete the seam a repo's
  "production needs a per-action yes" rule depends on.
- **An utterance outlives its recogniser.** Chrome ends a `SpeechRecognition` session on
  its own schedule — a long sentence outlives one — and the next instance starts with
  EMPTY `results`. So the words said before the seam live only in the session that just
  ended, and rendering the new session's results alone made the composer reset and refill
  with the tail of his own sentence, about twenty seconds in. `ui/listen.js` carries them
  across (`carry`), and consumption is tracked against the recogniser it belongs to,
  because by the time the settle window fires Chrome may have handed us a different one.
  `src/listen.test.ts` drives a stubbed recogniser and fails without the carry.
- **A tool call can arrive written in two formats at once.** Seen 2026-08-02 in beadgame,
  twice in one session: the model emitted `queue_decision` with the whole rest of the call
  inside the FIRST parameter — `context` ended `…turned out to be.</context>\n<parameter
  name="options">["Open a follow-up plan now", …]` and `options` was simply absent. Two
  costs, and the second is the one that hid: markup in the text Danny reads, and the
  candidate answers GONE, so a decision offered with four buttons arrived as free text.
  `src/toolInput.ts` takes it back at the tool boundary and logs what it recovered.
  ⚠ The recovery requires the tail to actually be a `<parameter name="…">` block — a
  closing tag alone is an ordinary sentence, because she writes about markup. It is
  applied to `say` too, where the failure would be READ ALOUD.
- **A worker only ever left the roster on a `task_notification`.** Anything that stopped
  one arriving — the task dying, an interrupt, `/clear` replacing the session it ran in —
  left it running forever, so the panel showed work in flight that was not and the
  activity dot stayed lit behind it. Nothing reconciled it because nothing could: that
  notification was the only signal. ⚠ No longer true (2026-08-28): the SDK grew
  `background_tasks_changed` — the full LIVE set on every membership change, a level
  where the bookends are edges — and `reconcileWorkers` (`state.ts`) closes any running
  worker absent from it. The grace window there is load-bearing: level/edge ordering is
  unspecified, and closing a worker off a start-adjacent level would kill it seconds
  after birth — the inverted bug, looking exactly like the feature working. Unknown ids
  are ignored (additions keep coming from `task_started`), and an old CLI that never
  emits the level degrades to exactly the old behaviour. `/clear` still orphans the
  roster (⚠ the DECISIONS still survive a clear — a question is durable, a task inside a
  replaced session is not), and the by-hand drops stay as the escape hatch (`× ` in the
  panel, `close_worker` for her). Same reasoning gives her `close_decision`: a queue with
  settled items in it is a queue you learn to ignore.
- **The Web Speech API grew keyterms, and `docs/voice-plane.md` predates it.**
  (Since 2026-08-29 this whole entry describes the FALLBACK ear — the default is
  Scribe, whose keyterms are server-side query params via `earHost.ts`, biased
  unconditionally from the same `keyterms.ts` vocabulary. What follows still
  governs `ui/listen.js` whenever it is the ear in force.) That
  record says a mangled project noun is "the keyterms case, and it is the signal to
  revisit [Scribe]" — no longer true on its own: Chrome now has contextual biasing
  (`recognition.phrases`, `new SpeechRecognitionPhrase(term, boost)`, verified present in
  Chromium 148), which is the same mechanism. `src/keyterms.ts` assembles the vocabulary
  and `ui/listen.js` applies it. ⚠ Per RECOGNISER, not once — Chrome builds a new one on
  its own schedule, so biasing set only on the first would stop applying twenty seconds
  into a long sentence, as invisibly as the `carry` bug. ⚠ And it must never cost the
  ear: a refusal drops the vocabulary, restarts plainly, and says so. Nothing calls
  `SpeechRecognition.install()` — that downloads a model onto the machine, which is not a
  page's decision. Biasing does NOT fix punctuation; that half of the Scribe case stands.
- **Not sending is a feature, and it has an ORDER.** Recognition mangles sentences often
  enough that "don't send that" is a control: `Listener.abandon()` drops the utterance in
  flight without closing the ear, and Stop/Escape calls it before emptying the composer.
  ⚠ That order is load-bearing — the recogniser still HOLDS the abandoned words, so
  clearing the box first just lets its next result render them straight back into it.
  Cancelling the settle timer alone was never enough; `consumedUpTo` has to be spent too,
  against the recogniser the words belong to (Chrome may have swapped it, same test as
  the settle callback). ⚠ And `off()` must never emit `onSettled`: reaching for the mic
  is what Danny does when the transcription is going wrong, so switching it off is a way
  OUT of the sentence, never a commit of it. Both are tested.
- **The ear and the send are separate controls.** A settled utterance sending itself is
  what makes voice a conversation and what makes DICTATION impossible — there is no
  moment to look at the sentence and fix the word Chrome got wrong, because it is
  already gone. The toggle between the mic and the composer (`autosend` in `ui/app.js`,
  remembered in `localStorage`) holds it in the box instead, to be edited and sent with
  Enter like anything typed. ⚠ Holding means the composer ACCUMULATES, which nothing
  else in the speech path does: every settle resets `carry`/`consumedUpTo`, so the next
  utterance arrives as if the box were empty and rendering it the autosend way would
  overwrite the sentence still sitting there unsent. `heldBase` is where the utterance in
  flight starts — null between utterances, which is the signal to APPEND to whatever the
  box holds, spoken or typed. ⚠ And `clearInterim()` returns early while holding: it is
  called when a turn is published, that is broadcast to every tab, and a draft is not a
  preview — the other tab sending something must not reach across and delete it.
- **A queued decision is a SUMMONS, and it used to be the only thing on the bus
  that was never spoken.** `speakOut` subscribed to `assistant` and `say` only, so
  the one thing genuinely waiting on Danny was the one thing never said out loud —
  which is what made `headlines` feel arbitrary from use. It now speaks at every
  level except `off`. ⚠ `pending` carries the WHOLE list and fires for unrelated
  reasons (a worker started, a worker finished), so the trigger is an id not seen
  before, not the message. ⚠ The seen-set is SEEDED from the first `pending`
  rather than started empty: the store restores decisions across a restart and
  publishes them, and an empty set reads Danny his whole backlog aloud on every
  boot.

- **`headings` is a SHAPE, not a volume.** The fifth speech level speaks only the
  markdown headings of what she writes (plus findings and events) — silence on
  prose that has none, which is the feature. ⚠ Fences are skipped: plans and diffs
  are full of `# comment` lines, and a shell comment read aloud as a section title
  is worse than nothing.

- **The end-of-turn bell is synthesised** (`ui/bell.js`) — two sine partials with
  an exponential decay, so no asset, no fetch that can 404, no dependency. It obeys
  the machine mute and volume because it is a noise this desk makes. ⚠ Rung on the
  turn-end EDGE, never the idle level, which repeats. ⚠ It is INDEPENDENT of the
  voice mute (Danny's call, from his use: he works muted). That mute is about her
  VOICE and about not paying for audio nobody wanted; a bell costs nothing, says
  nothing, and is most useful exactly when she is silent, because then it is the
  only signal a turn ended. It still rides the machine VOLUME, which is a level
  rather than a mute. ⚠ `last` starts at
  `-Infinity`: `currentTime` also starts at 0, so a zero there means the debounce
  swallows the very first bell — caught by the test, and it would have looked like
  a toggle that does nothing. ⚠ Gain is 0.28 BEFORE the machine volume: the first
  pass used 0.09, which at a 45% volume is a peak of 0.04 and inaudible in a real
  room. "Punctuation not content" is about the envelope, not about being too quiet
  to notice. ⚠ The mute silences it, so the button paints `suppressed` and says
  so — a bell switched on that never rings reads as a broken feature rather than
  as a muted desk.
  ⚠ **A page open since before a UI change is running the OLD `ui/*.js`.** Danny
  had beths up for 19 hours; nothing pushes to them and nothing warns. When a UI
  change "does not work", check the tab's age FIRST.

- **Plans are READ in the harness now, and `md.js` is not `markdown.ts`.** The
  preview modal (`/api/plan`, `ui/md.js`, `openPlanPreview` in `app.js`) renders a
  plan body; `markdown.ts` STRIPS markers off what Beth writes so link offsets stay
  stable and TTS does not pronounce asterisks. Opposite jobs — sharing them would
  put a renderer in the path of the speech excerpt. ⚠ The endpoint is allowlisted
  to real markdown inside the repo (`resolveMarkdown`); "any file under the repo"
  would serve `.env`.
  ⚠ READ-ONLY by construction: checkboxes are `disabled`, not merely un-wired,
  because the harness does not write plan files.
  ⚠ ANY markdown in the repo opens the reader, not just indexed plans
  (`resolveMarkdown`, the same geometry fence as `resolveImage`): she links
  ordinary docs too, and those fell through to a `vscode://` prompt — the exact
  interruption the reader exists to remove. Index membership grants the ACTIONS;
  being real `.md` inside the repo grants the read.
  ⚠ Opening the reader does NOT point Beth at the plan, and since 2026-09-01 the
  row's NAME opens it too. Reading is the common act, so it gets the biggest
  target; pointing is the deliberate one and moved to an explicit `→`. The chip
  is SYNCED to `/api/point`, so attaching one on a look quietly changed what
  Danny's next turn said.
  ⚠ `/api/plan` returns the WORK ITEM, because the page cannot look one up:
  `byPathAll` is the in-flight slice and cited plans are mostly finished, so the
  reader opened a parked plan with a filename for a title and no actions. Third
  time this trap has bitten — anything keyed off `byPathAll` must assume a miss. Scope came from the corpus (40
  unity plans: 1556 bullets, 643 headings, 502 fences, 396 checkboxes, 354 table
  rows, 310 quotes), and the parse is pure so it is tested in node. ⚠ Two bugs
  here were only visible ON SCREEN: an unstyled sheet is TRANSPARENT (`.sheet`'s
  background lives under `#pending-overlay .sheet`), and a wrapped bullet broke
  out of its list into an unindented paragraph — all the text present, so both
  read as formatting quirks rather than faults.

- **Agents talk in plan NUMBERS, and nothing mapped them back.** `/plans new
  --series` mints `YYYY-MM-DD-NN-slug.md`, so workers and Beth say "recorded that
  in plan 174" while the panel shows titles — 286 of beadgame's 623 plans carry a
  number, and connecting the two was manual. `links.ts` now resolves a cited
  number to a link (`plansReader.seriesNumber` parses it, `workIndex.byNumber`
  looks it up), and clicking one REVEALS the row: `revealPlan` in `ui/app.js`.
  ⚠ The number is NOT an identity — the counter is per scope directory, so
  beadgame has two plan 22s and 64 more collisions, all in the low long-shipped
  range while every number agents actually cite is unique. `byNumber` returns
  nothing when ambiguous, because a confidently wrong link looks resolved and so
  nobody checks it. ⚠ A BARE number is never linked ("timeout 180", "79175 tok");
  the word `plan` or a `#` is required. ⚠ `revealPlan` is async because the
  default panel holds only in-flight plans and the cited ones are usually
  finished — it widens scope, re-fetches, opens the status group and every
  umbrella above the row, then scrolls the PANEL by assignment. Not
  `scrollIntoView` (it drags the transcript the reference was read in), and not
  `behavior:'smooth'` (measured: silently does nothing in a hidden pane).

- **The numbers hang from the STRIP** (2026-09-01). `.stats` moved from
  `bottom: 78px` to `top: 44px`: the controls that open it are the top-right
  meters, and reaching to the bottom-right for what a top-right control opens was
  the wrong way round. Both gauges survive and both open the same panel — the
  composer gauge is where the eye already is mid-conversation, the strip's is
  where the other meters are. ⚠ The strip's third bar is CONTEXT, and it is the
  one that is never absent: the plan windows hide entirely on an API-key/Bedrock/
  Vertex session (an unfillable gauge is worse than none), so `#usage-meters` now
  stays visible on the ctx bar alone. ⚠ `paintMeter` calls `renderUsageMeters`;
  `renderUsageMeters` must not call back, and `loadPlanUsage` still calls it
  directly — dropping that call silently freezes the windows at their first
  paint.

- **The GitHub link is GONE** (2026-09-01), and with it `/api/github`,
  `src/repoWeb.ts`, `hasWeb`/`blobUrl`, and the `repoOnWeb` flag on `hello`. The
  in-harness reader replaced the reason to leave the page, so the button had
  nothing left to do; deleting the whole path beat leaving a dead endpoint behind
  it. ⚠ Its LESSON outlives it and now lives on `/api/image` and `/api/plan`: an
  endpoint that builds a response from a query parameter answers only what it can
  PROVE, because the loopback bind is not a reason to let a URL name any file on
  the machine. If a web link ever comes back, re-read this entry in git history —
  the ref must be resolved at the CLICK (Danny switches branches mid-session) and
  the host's URL SHAPE cannot be assumed from the remote.

- **Becoming someone else is a NEW SESSION, and that is structural.** Model, permission
  mode and effort all have setters on a running query; the system prompt does not — it is
  fixed when `query()` is constructed, and `reinitialize()` is for transport gaps, not for
  changing who is in the room. So `setPersona` ends with `clear()`, and the page confirms
  before it posts, because a dropdown that silently threw away an hour of conversation
  would be the worst control on it. ⚠ Two things follow her rather than the repo: her
  VOICE (`speakOut.setVoice` — and it must drop the resolve CACHE, or the new director
  sounds exactly like the old one and nothing else tells you) and her MEMORY of Danny
  (`personaStateDir`). Her greeting rut does not: a habit is formed against a project, so
  that file is keyed by both. ⚠ And `seedMemory` copies an existing memory across ONCE,
  only when the persona's name matches the repo's own director — otherwise picking "Beth"
  in a repo that already made her Beth would make her forget him, which would look exactly
  like the feature working.
  ⚠ There is NO voice picker any more (removed 2026-08-31, with `/api/voice`,
  `/api/voices`, `speakOut.voices` and `mouth.voices`). It auditioned without writing, so
  a reload or a persona switch undid every choice made in it — which is correct behaviour
  for a control that should not exist: a voice belongs to a persona, and the `voice:` line
  in her file is the only answer. Do not add one back. `setVoice` stays because the
  persona switch is what calls it.
- **Reasoning effort has two owners.** The strip picks a level that stands until it is
  changed; the mic DUCKS it to `voiceEffort` for as long as it is open, because spoken
  conversation trades depth for latency. So the choice is kept separately from what is in
  force (`session.ts`), and `/api/listening` calls `duckEffort`, never `setEffort` —
  otherwise closing the mic restores "default" over a level chosen while it was open, and
  the select goes on claiming the level it no longer has. ⚠ Effort is a flag on the
  QUERY, not an option it was built with, so `/clear` comes up at the model's default:
  `clear()` re-applies what was in force. The select shows the CHOICE, not the duck —
  a readout that dropped to `low` every time he reached for the mic would look like the
  harness overruling him.
- **The wire panel PULLS; nothing about it rides the bus.** `wireTap.ts` records a
  compact form of every SDK message (session.ts taps `handle()` before its switch — the
  types the switch ignores are the panel's whole point) and the page fetches
  `/api/wire?since=` on a cursor only while the panel is open. Putting this on the bus
  would bloat the replay for every tab whether or not anyone ever looks. ⚠ Previews are
  truncated AT CAPTURE (a test run's output is megabytes, the ring holds 800 entries),
  and `includePartialMessages` is on so the anatomy strip gets block boundaries and the
  SDK's own ttft stamp — the deltas themselves are folded away in the tap, never stored.
- **One mouth, however many tabs are open.** Voice used to be a machine singleton, so two
  browser pages could not both speak no matter what. Every page can play audio now, and two
  tabs on one harness means hearing her twice, slightly out of phase, on top of herself.
  Two tabs is legitimate (two monitors), so `server.ts` ELECTS a speaker — newest
  connection by default, and a page claims it on focus — and `speak` is the one message
  that does not broadcast. Anything added that makes noise needs the same treatment.
- **One machine, several beths — the voice ROOM.** Three harnesses each elect their own
  speaker and know nothing of each other, so three voices could land at once — and three
  browser origins share no channel, so the coordination is FILES in `~/.director-harness/`
  (`src/voiceRoom.ts`): a talking STICK taken where a `speak` is published (`speakOut.ts`
  queues; held for the whole thought, released when the page reports playback done via
  `/api/voice/done` — then only after a LINGER, long while her turn is in flight and cut
  short when it ends, because a list is short lines with generation gaps and releasing
  into a gap is how a beth sneaks in mid-list; backstops for a tab that never reports are
  sized to the whole unplayed queue, not the line — a tail line sized to itself expired
  while still waiting its turn on the page — restarted by page reports and never by each
  other), a
  universal MUTE, and one machine-wide VOLUME (the strip's slider — it left the stats
  panel when it stopped being this page's dial). ⚠ The mute gates at the bus subscription,
  so a muted line is never held, fetched, or BILLED — volume zero still bills, and the two
  tooltips say which is which. The reread click bypasses the mute on purpose (a click is
  an explicit request — the same rule that lets it speak at level `off`), and unmute
  replays nothing (news that has passed). Three degradations are load-bearing: a broken
  room speaks UNCOORDINATED (overlap is the old behaviour; silence would be a new bug
  with no symptom), a boot with no tab connected skips the stick (nothing will play, and
  holding it would let a headless greeting silence the other two for the backstop), and a
  stale stick is stolen only when provably dead — past TTL or dead pid, cleared by
  RENAME so two stealers cannot unlink each other's fresh stick — because a wrong steal
  cuts into a live sentence, the inverted bug that sounds like the feature working.
  ⚠ The dial CANNOT rest on `fs.watch` alone. It stops delivering across a macOS
  sleep and fails silently, so a page goes on rendering what it last heard —
  Danny found three harnesses showing muted after a night idle while speech
  played, which is the same failure whichever way the truth drifted. `watch()`
  now runs a 3s re-read beside the watcher; it publishes only on change, so a
  quiet room costs two `existsSync` per tick and nothing else.
  ⚠ And the mute button sends an INTENT (`toggleMute`) **and** a computed
  `muted`, and the pair is load-bearing. The intent is preferred by the server,
  so a page whose belief has gone stale cannot do the opposite of what its own
  icon shows. The computed value is the FALLBACK for a server that predates the
  intent — and that is not a theoretical case: `ui/` is served fresh from disk on
  every load while the harness is a process that has been up for days, so a
  reload routinely pairs a NEW page with an OLD server. Shipping only the intent
  made the button do nothing at all there. ⚠ This cuts both ways and is the
  general rule: a change to the page↔server contract must degrade on an old
  server, or it breaks every harness Danny has not restarted — the mirror of the
  stale-tab gotcha below.
  ⚠ Nothing in this repo deletes `voice.mute` except an explicit unmute (the
  creditMeter sweep matches only `credits-*.jsonl`; the stale-stick steal touches
  only stick files) — so if it vanishes again, suspect something outside the
  harness. The poll means the page will at least stop lying about it.
  ⚠ The mute is checked at THREE points, not one, and the extra two are why
  Danny stopped hearing lines after clicking it. The bus-subscription gate runs
  when she WRITES; the line then waits — for TTS, and for the stick, which blocks
  as long as another beth is mid-sentence — so `onLine` and `pump` re-check, and
  `pump` DROPS what it finds (unmuting replays nothing; by then it is news that
  has passed) and lets the stick go with it. ⚠ The reread bypass has to survive
  all three: `explicitNext` covers the synchronous span inside `speak()`, where
  `mouth.speak` calls back before returning an id to register, and the id set
  covers every gate after. ⚠ The tests for this were VACUOUS at first and passed
  against the broken code — `acquire()` polls every 250ms and the waits were
  60ms, so nothing had published either way. Wait past the poll, and check a new
  test fails without the fix.
  Every way a line ends on the page (played, refused, errored, stopped) must reach
  `report` in `speaker.js`; an unreported ending holds every other beth quiet with no
  symptom on the page that caused it.
- **The director's NAME comes from the bound repo** (`directorName.ts` reads "You are
  **X**" out of `.claude/DIRECTOR.md`). It is not decoration: a card reading "Claude
  wants to use Bash" is a stranger interrupting a conversation with someone else.
  Nothing in `ui/` may hardcode it — the page learns it from `hello`.
- **She writes markdown, and the page renders offsets.** File links are character RANGES
  into the message text, computed server-side, so nothing in `ui/` may transform that
  string — the offsets would move underneath. Markdown markers come off in `markdown.ts`
  BEFORE links are detected, and the formatting they carried travels as spans in the
  same coordinates. One canonical string, two overlays that cannot disagree. The voice
  path takes that string too, which is what stops TTS pronouncing asterisks.
- **The API key needs the Text to Speech permission**, and only that. The old dial-in
  path needed the row labelled "ElevenAgents" instead (there is no "Speech Engine" or
  "Conversational AI" entry), which is why a key that worked for years produced a 502
  the first time the harness called TTS directly. Keep ElevenAgents only if
  `SPEECH_ENGINE_ID` is still where the voice id is read from; `HARNESS_VOICE_ID` makes
  it unnecessary.
- **The engine's TTS model is NOT available to the standalone endpoint.**
  `eleven_v3_conversational` is rejected outright, so the plane runs
  `eleven_flash_v2_5` — the same voice, a different model. ⚠ Flash predates v3 audio
  tags, so `speakOut` strips them; it derives that from the model in use, not from the
  engine. Point `HARNESS_TTS_MODEL` at a v3 model and tags survive.

## Design records

`docs/` is where agreed-but-unbuilt work lives, so a fresh session can pick it up without
the conversation that produced it. Where things stand:

- **`voice-plane.md`** — DONE, all four steps. She speaks over `src/speakOut.ts`
  (loopback audio, no session, no mic) and hears over `ui/listen.js` (browser
  recognition posting an ordinary turn). Speech Engine, the voice port, the tunnel, the
  singleton, the announcement queue, `speakable`, `SILENT_ACK`, `runTurn` and the cost
  meter are all gone. Read it for the reasoning, not for work. ⚠ Its "what would flip
  this" table has two dated corrections: Chrome grew contextual biasing (2026-08-02,
  which narrowed the Scribe case to punctuation and VAD), and the Scribe deferral was
  LIFTED on 2026-08-29 — the reason from use was punctuation, the half biasing never
  touched. The ear's future lives in `ear.md`; this record is history.
- **`ear.md`** — AGREED, unbuilt (2026-08-29). Owning the capture: the page streams
  PCM to the harness, the recogniser sits behind an `EarEngine` interface (Scribe
  first, local later), VAD commits replace the settle window, the engine punctuates,
  and `ui/listen.js` stays whole as the fallback. Read it for the module boundary,
  which is the requirement that shapes everything: the speech stack — ear AND mouth —
  becomes a liftable library with harness adapters, because Danny wants it in other
  projects. BUILT through step 5 (2026-08-29) — the mouth seam included:
  `src/mouth/mouth.ts` is the speech-out core (held lines, TTS, voice resolution,
  the bill) behind injected credentials and one `onLine` callback, with
  `speakOut.ts` as its config/bus adapter, mirroring how `src/ear/` is the liftable engine
  (native `WebSocket`, single-use token as `?token=` — `ws` stays deleted; ⚠
  `session_started`, not socket open, is the go signal, because errors arrive as
  typed frames after a clean open; keyterms are repeated query params, ⚠ ≤20 chars
  each — oversized is FATAL, so `filterKeyterms` drops loudly), `src/earHost.ts` is
  the harness adapter (one ear, newest armer steals, spend metered at forwarding),
  and `ui/pcm.js`/`capture.js`/`remoteEar.js` are the page half — `RemoteEar` wears
  the Listener's exact surface so `app.js` swaps by `hello.ear`, and `degraded`
  swaps the browser ear back in mid-conversation. `scribe` is the DEFAULT since
  2026-08-29 (first real Chrome session worked; Danny called it earned):
  `HARNESS_EAR=browser` opts out, a keyless harness degrades to the browser ear at
  `hello`, and `listen.js` stays untouched as that fallback. The engine
  round-tripped the live service VERBATIM (keyterms on; "Coliseus" without).
  Echo/duplex is still unmeasured — parking ships. Fixtures in `src/ear/fixtures/`
  are REAL captured frames; keep them so. Step 6 (a local Kyutai engine) is
  DEFERRED with its reopening signals recorded in the doc — do not spike it
  without one from use; the hope was never "we don't need Scribe" (Kyutai has no
  keyterms, and keyterms are the whole ballgame).
- **`status-surface.md`** — DONE. The dot tracks anything running, the spinner tracks the
  prediction, the numbers live behind the context meter (with the SDK plan windows, read
  defensively), and the test monitor SHARES the top right — since 2026-08-31 with the
  build light, the gear, and the two usage meters that came back to the strip (5h at
  100% is when credits start draining, the one number worth no click). The doc carries
  dated corrections for that reversal and for the gear layer winning over
  `HARNESS_TEST_CMD`. Read it for the parser lessons,
  which are recorded there rather than here because they are about `testRunner.ts`.
  The same panel now carries the SPEECH bill — and note what that is not: the deleted
  cost meter metered a Speech Engine CONNECTION, which is why it went with the dial-in
  path. This one counts characters at the moment `speakOut.stream()` requests them,
  because that is what ElevenLabs charges for. ⚠ Do not move the count to `speak()`: a
  held line nobody fetched was never billed, and a reload that re-fetches one is billed
  twice. Characters are exact; the DOLLARS are an estimate, since credits-per-character
  comes from the model but dollars-per-credit comes from the plan and no API hands us
  that — so the assumed rate is printed beside the number rather than hidden behind it.
  The USAGE-CREDIT countdown (`src/creditMeter.ts`, 2026-08-30) is the same contract at
  its limit: NOTHING can read the real balance (no SDK field, no CLI surface, no consumer
  API — researched, not assumed), so the budget is Danny's (`HARNESS_CREDITS_MONTHLY`,
  machine .env — one account per Mac), the ledger is machine-wide JSONL keyed by billing
  cycle (per-cycle files because three beths append concurrently and a prune-rewrite
  could eat a neighbour's append), and turns are counted ONLY while a plan window reports
  100% — Danny's explicit choice, because credits drain only after the plan is spent, and
  counting covered turns would bill money never drawn. ⚠ The panel's mode line is
  load-bearing: an unarmed meter's zero must read "not drawing credits", never "broken".
  The exhaustion verdict is cached a minute; a failed read means NOT armed.
- **`personal-context.md`** — BUILT (`src/personal.ts`). She remembers the person and
  follows things up. Read it for the failure mode, which is the whole design: she may only
  ask about something she ACTUALLY RECORDED, at most once a day, only at a moment already
  hers. Most days are silence and that is correct.
- **`plans-panel.md`** — largely BUILT: the panel, deixis (pointing), links and handoff
  all ship, plus a PINNED shelf, rename, and UMBRELLA hierarchy (`parent`/`isUmbrella`
  off the first `depends_on` entry, folding in the panel) — so do not re-plan any of
  those off the doc's "still open" list, which now carries dated corrections. Read it
  for why a reference is a pair rather than a string. The shelf is Danny's ordering laid over the index's: pinned
  rows still appear in their status group, because a plan that vanished from `active`
  because it was pinned would make the board lie about what is active.

Already done from the same list, so do not re-plan them: the spoken settle window is
2500 ms, the speech levels and last-paragraph excerpt exist (`spoken.ts`), and the
activity lines and in-progress indicator are in.

## Process

Small repo, one developer, usually one session. It deliberately does **not** have
beadgame's plans/claims/hooks machinery — that exists to coordinate many concurrent
sessions, which is not a problem here. Design records go in `docs/`; git history is the
rest. Add ceremony only when something actually hurts.
