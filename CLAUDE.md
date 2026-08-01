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
`spokenName`, the `plansReader` parsers, the `workIndex` watcher, and `speakOut` — which
is now the whole speech plane, so what it does and does not pronounce is worth pinning).

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
  say "I am here" three times — see the KICKOFF note in `main.ts`.
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
  question it ends on: whether to move recognition to Scribe, which would punctuate
  properly and let echo cancellation reach the recogniser at last.
- **`status-surface.md`** — step 1 is BUILT: the dot tracks anything running, the spinner
  tracks the prediction. Next the stats move behind the context meter, then the test
  monitor takes the top right.
- **`personal-context.md`** — not started. A director who remembers the person, not only
  the work.
- **`plans-panel.md`** — largely BUILT: the panel, deixis (pointing), links and handoff
  all ship. Read it for why a reference is a pair rather than a string.

Already done from the same list, so do not re-plan them: the spoken settle window is
2500 ms, the speech levels and last-paragraph excerpt exist (`spoken.ts`), and the
activity lines and in-progress indicator are in.

## Process

Small repo, one developer, usually one session. It deliberately does **not** have
beadgame's plans/claims/hooks machinery — that exists to coordinate many concurrent
sessions, which is not a problem here. Design records go in `docs/`; git history is the
rest. Add ceremony only when something actually hurts.
