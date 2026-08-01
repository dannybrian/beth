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
- **Secrets never live here.** Config is read from the BOUND REPO's `.env` (or real env
  vars) — see `src/config.ts` and `.env.example`. Nothing in this repo should contain a
  key.
- **Comments explain WHY.** Several of the trickiest bits exist because of a bug that was
  expensive to find; those comments are load-bearing. Don't strip them.

## Testing

```bash
pnpm test        # node --test src/*.test.ts
```

Tests are thin and concentrated where behaviour is subtle (`audioTags`, `spokenName`,
the `plansReader` parsers, the `workIndex` watcher). The turn-stream timing in `voice.ts`
has produced two real bugs and has no tests — a good place to add some.

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
- **`speechEngine.update()` ignores a top-level `wsUrl`.** It is nested under
  `speechEngine`. The bad call returns success and changes nothing, so the harness reads
  the config back and derives its listen path from what is actually stored.
- **Never wire Speech Engine's abort signal to `Query.interrupt()`.** It aborts on
  ordinary transcript revisions (partial → final), not just barge-in. Doing so kills the
  director's turn on every utterance and produces an endless re-delivery loop. Stop is a
  button, deliberately.
- **A spoken turn must never return zero chunks** — ElevenLabs re-delivers the transcript
  when it gets nothing, which restarts that same loop.
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
- **The ElevenLabs API-key permission is the row labelled "ElevenAgents"** (Write). There
  is no "Speech Engine" or "Conversational AI" entry. TTS/STT permissions are *not*
  needed — speech happens inside the Speech Engine session.

## Process

Small repo, one developer, usually one session. It deliberately does **not** have
beadgame's plans/claims/hooks machinery — that exists to coordinate many concurrent
sessions, which is not a problem here. Design records go in `docs/`; git history is the
rest. Add ceremony only when something actually hurts.
