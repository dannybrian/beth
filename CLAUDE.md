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
  a framework would cost more than it saves.
- **Ask before adding any dependency.** Current total: the Agent SDK, zod, and the
  ElevenLabs SDK (for TTS, nothing else). Each was a deliberate decision. Prefer rolling
  a small thing over taking a package. The browser client and `ws` both left with the
  dial-in path, which is what a good deletion looks like.
- **Secrets never live here.** Config comes from three layers, most specific first: real
  env vars → the BOUND REPO's `.env` → `~/.director-harness/.env`. The ElevenLabs
  credentials belong in that machine file: one account per Mac, so a per-repo copy
  duplicates a secret, and forgetting one makes the new repo silently text-only. See `src/config.ts` and `.env.example`. Nothing in this repo holds a key.
- **Comments explain WHY.** Several of the trickiest bits exist because of a bug that was
  expensive to find; those comments are load-bearing. Don't strip them.

## Testing

```bash
pnpm test        # node --test src/*.test.ts
```

Tests are thin and concentrated where behaviour is subtle (`audioTags`, `markdown`,
`spokenName`, the `plansReader` parsers, the `workIndex` watcher, `speakOut` — which is now
the whole speech plane, billing included — the `testRunner` detectors and failure parsers,
and `listen`, which drives a STUBBED `SpeechRecognition` so the seams Chrome creates can be
tested at all. Browser code is testable when the hard part is bookkeeping rather than the
browser.

The rest earn their tests by being places a mistake is INVISIBLE: `toolInput` (a malformed
call recovered from the real payload), `planName` (the one writer — that it round-trips
through the real reader, and that nothing else in the file moves), `pins` (that a shelved
plan survives a restart and still shows when it is not in flight), `state` (a worker
leaving the roster when nothing will ever report it), `keyterms`, `greeting`, and
`stylesheet`, which exists because a stray `*/` drops CSS rules with no error anywhere.

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
  notification is the only signal and it is not coming. Now `/clear` orphans the roster
  (⚠ the DECISIONS still survive a clear — a question is durable, a task inside a
  replaced session is not), and both Danny and Beth can drop one by hand (`× ` in the
  panel, `close_worker` for her). Same reasoning gives her `close_decision`: a queue with
  settled items in it is a queue you learn to ignore.
- **The Web Speech API grew keyterms, and `docs/voice-plane.md` predates it.** That
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
- **A link to GitHub is resolved at the CLICK, not served with the page.** The row's ↗
  points at `/api/github?path=…`, which 302s (`src/repoWeb.ts`). Two reasons, and the
  first is the one that bites: Danny switches branches mid-session, so a URL built when
  the page loaded would quietly point at wherever he was standing that morning — the ref
  is the current branch, or the SHA on a detached HEAD. The second is that the tab opens
  on the gesture with no await in front of it, so nothing blocks it as a popup. ⚠ The
  endpoint takes a path from a query string: only paths the INDEX knows are answered,
  because loopback is not a reason to let a URL name any file on the machine. github.com
  only — the remote gives us the host but not that host's URL SHAPE (GitLab wants
  `/-/blob/`), and a button that opens a plausible 404 is worse than no button, so
  anything else draws nothing at all.
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
- **One mouth, however many tabs are open.** Voice used to be a machine singleton, so two
  browser pages could not both speak no matter what. Every page can play audio now, and two
  tabs on one harness means hearing her twice, slightly out of phase, on top of herself.
  Two tabs is legitimate (two monitors), so `server.ts` ELECTS a speaker — newest
  connection by default, and a page claims it on focus — and `speak` is the one message
  that does not broadcast. Anything added that makes noise needs the same treatment.
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
  meter are all gone. Read it for the reasoning, not for work — what is left is the
  question it ends on — Scribe — which is DEFERRED as of 2026-08-02: the Web Speech API
  stays for now. The research is recorded there (realtime Scribe has VAD endpointing and
  keyterms, both of which would retire patches). ⚠ Its "what would flip this" table said
  mangled project nouns could only be fixed by Scribe; that stopped being true when Chrome
  grew contextual biasing, and the record carries a dated correction saying so. The
  reopening signal is now narrower: nouns still wrong WITH a boosted vocabulary in place.
  Punctuation and VAD are untouched by biasing and remain Scribe's case.
- **`status-surface.md`** — DONE. The dot tracks anything running, the spinner tracks the
  prediction, the numbers live behind the context meter (with the SDK plan windows, read
  defensively), and the test monitor has the top right. Read it for the parser lessons,
  which are recorded there rather than here because they are about `testRunner.ts`.
  The same panel now carries the SPEECH bill — and note what that is not: the deleted
  cost meter metered a Speech Engine CONNECTION, which is why it went with the dial-in
  path. This one counts characters at the moment `speakOut.stream()` requests them,
  because that is what ElevenLabs charges for. ⚠ Do not move the count to `speak()`: a
  held line nobody fetched was never billed, and a reload that re-fetches one is billed
  twice. Characters are exact; the DOLLARS are an estimate, since credits-per-character
  comes from the model but dollars-per-credit comes from the plan and no API hands us
  that — so the assumed rate is printed beside the number rather than hidden behind it.
- **`personal-context.md`** — BUILT (`src/personal.ts`). She remembers the person and
  follows things up. Read it for the failure mode, which is the whole design: she may only
  ask about something she ACTUALLY RECORDED, at most once a day, only at a moment already
  hers. Most days are silence and that is correct.
- **`plans-panel.md`** — largely BUILT: the panel, deixis (pointing), links and handoff
  all ship, plus a PINNED shelf and rename (2026-08-02). Read it for why a reference is a
  pair rather than a string. The shelf is Danny's ordering laid over the index's: pinned
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
