# director-harness

I wanted to talk to my projects.

Not to a chatbot about code in general — to a standing director on *this* repo:
someone who has already read the board, knows what shipped yesterday, holds the
shape of the work while I hold a coffee, and can be talked to out loud while I
pace. Claude Code gives me the session; what it doesn't give me is the *person*
across from me — a name, a voice, a memory of me, an opinion about what I
should do next, and a place to see the work while we argue about it. So I built
the room: a long-lived Agent SDK session bound to one repo, reachable by text
or by voice, with the project's work on a panel beside the conversation.

```bash
cd ~/Sources/your-project && beth
```

That binds to the git root you are standing in, picks a free port (several
repos run side by side), opens the browser, and tears everything down on
Ctrl-C. `beth --help` for flags.

The design is one contract with three suppliers, and almost everything about
the harness falls out of it:

- **The harness supplies the ROLE** — an expert project manager who converses
  instead of reporting, narrates before anything slow, and protects your
  attention. It is project-agnostic on purpose and ships with opinions about
  *how* to direct, none about *what*.
- **Your repo supplies the PERSON and the WORK** — who the director is
  (`.claude/DIRECTOR.md`) and what is in flight (`plans/`). The harness only
  ever *reads* your repo.
- **Your machine supplies the IDENTITIES** — credentials, and optionally
  *personas*: directors of your own that exist across every repo, with their
  own voices and their own memory of you (`~/.director-harness/personas/`).

## Getting a repo ready: /director-skills

The fastest way to see what the fuss is about is a repo that supplies its half
of the contract — and rather than document the formats in prose (which would
drift from the parser the moment either changed), the repo half ships as a
skill that sets it up with you:

```bash
ln -sf ~/Sources/director-harness/skills/director-skills ~/.claude/skills/director-skills
```

Then, in any repo, ask its director (or any Claude Code session) to run
`/director-skills`. It diagnoses before it writes: a repo with plans the
harness cannot read gets told *why* (often the fix is one env line); a
greenfield repo gets the format bootstrapped from managed templates — the
plans directory, the frontmatter schema, a vendored copy of the `/plans`
session tracker with its tests, `/tidyrepo` — and a director interviewed into
existence, because a person is the one thing a template cannot supply. The
harness will also offer this itself, once, when it boots against a repo with
nothing to read — with evidence, not as a wizard.

The reasoning is in `docs/director-skills.md`. This repo's own
`.claude/DIRECTOR.md` is the worked example of the interview's output.

## What talking to it is like

Text works like any chat, with three differences that matter to me:

- **The panel is shared ground.** Clicking a plan *points at it* — she gets the
  reference, you get a chip, and "what's left on this?" needs no name. Rows
  carry a pin, a rename, a GitHub link, and one-click handoff to a fresh
  Claude Code terminal session seeded with the plan.
- **Decisions queue instead of interrupting.** Anything she wants decided but
  isn't blocked on lands in a queue with candidate answers as buttons. Both of
  you can close items; a queue with settled things in it stops being read.
- **She narrates.** Before anything longer than a breath — "hold on, running
  the suites" — and after it lands. Silence reading as failure is a voice
  lesson, but it improved the text too.

**Voice is local end to end.** The browser recognises what you say
(`ui/listen.js`) and posts an ordinary turn; her replies stream back over
loopback as audio (`src/speakOut.ts`). Nothing dials in, nothing tunnels,
nothing is billed while idle, one listener bound to 127.0.0.1. Chrome only —
the Web Speech API is not in Safari or Firefox. Speech is an *excerpt* (the
page skims in seconds what audio cannot skip), the mic ducks reasoning effort
for latency, a settle window keeps half-sentences from becoming turns, and an
autosend toggle turns conversation into dictation when you want to edit before
sending. `docs/voice-plane.md` has the full story, including everything this
replaced.

She speaks in whatever voice her file names (`voice:` in a persona, or
`HARNESS_VOICE_ID`); the picker in the strip auditions the account's voices
live without writing anything down. Needs an `ELEVENLABS_API_KEY` with the
**Text to Speech** permission — without it the harness runs text-only and the
mic button explains what is missing.

## Personas

`~/.director-harness/personas/*.md` — one markdown file per director, none
shipped. Frontmatter names her and her voice; the body is who she is. A repo's
`DIRECTOR.md` still composes on top: the persona says who she is, the repo says
what this project needs from her, and the repo wins where they overlap. Her
memory of you follows *her* (switching repos doesn't reset the relationship);
her greeting habits stay per-project. Switching personas is a new conversation
— the page warns you — because a system prompt is fixed at session birth, and
you don't swap who you're talking to mid-thought.

An existing `DIRECTOR.md` copied into that directory *is* a valid persona —
the name is read from the same "You are **X**" sentence.

## What she remembers, and when she asks

`personal.jsonl`, append-only, never in your repo. The rule that keeps it from
being a rapport script: she may only ask about something she actually recorded
— a question comes from a fact with a date on it, at most once a day, only at
a moment already hers (the boot greeting, or the first turn after a long gap).
Most days that is silence, which is correct. `HARNESS_PERSONAL=off` means off:
nothing recorded, nothing asked.

The greeting itself is hers to write, one sentence, made different each day by
the two things a fresh session can't otherwise have: what she opened with
recently ("not these"), and the facts that changed — branch, dirt, last
commit, what's in flight, the clock, the gap since she was last up.

## The rest of the surface

- **Tests**: the top-right light detects the project's test command (never
  invents one), runs it when the tree settles and she is idle, and is **off
  until you enable it per repo** — this executes project code on a schedule.
  Clicking a failure drops a chip, not a stack trace.
- **Permission cards**: tool calls she can't settle herself become cards; a
  card cannot be answered by voice, so the session defaults to the SDK's
  `auto` mode and "Always" scopes its rule to the session — never written to
  your repo's settings from a button.
- **Director-role handoff**: if a terminal session already holds the director
  plan, the harness comes up as a *shadow* — read everything, claim nothing.
  Promotion re-checks at the moment you click it.
- **The strip**: model, reasoning effort, permission mode, speech level, voice
  audition, persona — all live, all showing what the *server* believes rather
  than what was clicked.

## Running it

```bash
ln -sf ~/Sources/director-harness/bin/beth.mjs ~/.local/bin/beth   # once
cd <a-project-repo> && beth
```

Or directly, without port-picking: `node src/main.ts` → http://localhost:4620.

No build step — Node ≥ 23 runs `.ts` natively. Three dependencies, each
deliberate: the Claude Agent SDK, zod, and the ElevenLabs SDK (TTS only). The
UI is dependency-free vanilla DOM over SSE + POST.

Config layers, most specific first: real env vars → the bound repo's `.env` →
`~/.director-harness/.env` (credentials belong in the machine file). Per-repo
state lives in `~/.director-harness/<repo-slug>/`; persona state in
`~/.director-harness/persona-state/<slug>/`. Nothing in this repo holds a key.

| Env | Default | Meaning |
|---|---|---|
| `HARNESS_PORT` | `4620` | Run a second instance alongside |
| `HARNESS_MODEL` | `claude-opus-5` | Director session model — the dominant cost lever |
| `HARNESS_CLAUDE_BIN` | `~/.local/bin/claude` | Native CLI (see gotcha below) |
| `HARNESS_DIRECTOR_PLAN` | — | The role-lock plan (`/director-skills` creates one) |
| `HARNESS_PLAN_ROOTS` | `plans` | Where plans live, when not `plans/` |
| `HARNESS_NO_KICKOFF` | — | Boot silently (cheap for testing) |
| `ELEVENLABS_API_KEY` | — | Voice. Needs the **Text to Speech** permission |
| `HARNESS_VOICE_ID` | — | The machine's default voice; personas override |
| `HARNESS_TTS_MODEL` | `eleven_flash_v2_5` | ⚠ Flash predates v3 audio tags — tags stripped |
| `HARNESS_SPEECH_LEVEL` | `brief` | How much is read aloud |
| `HARNESS_TTS_USD_PER_1K_CREDITS` | `0.22` | Your plan's credit price, for the estimate |
| `HARNESS_VOICE_SETTLE_MS` | `2500` | How long words must stop changing before a spoken turn sends |
| `HARNESS_VOICE_EFFORT` | `low` | Effort while the mic is open (`off` disables the duck) |
| `HARNESS_SPEECH_BIASING` | `off` | Bias the recogniser toward this project's nouns |
| `HARNESS_KEYTERMS` | — | Nouns no file mentions. ⚠ Accumulates across layers |
| `HARNESS_KEYTERM_BOOST` | `2` | How hard to push, 0–10 |
| `HARNESS_TEST_CMD` | detected | Test command override |
| `HARNESS_PERSONAL` | on | `off` disables remembering the person entirely |

## What's here

| Module | Owns |
|---|---|
| `session.ts` | The one long-lived streaming `query()`; turns; model/effort/permission/persona switches |
| `askgate.ts` | `canUseTool` — questions pend, everything else becomes an approve/deny card |
| `tools.ts` | In-process MCP: `say`, `queue_decision`, `close_decision`, `close_worker`, `pending`, `plans`, `speech`, `remember`, `recall` |
| `toolInput.ts` | Repairs a tool call written in two formats at once |
| `personas.ts` | Machine-level directors: reader, per-repo choice, memory seeding |
| `speakOut.ts` / `spoken.ts` / `audioTags.ts` | The speech plane: what is said, held, streamed, billed |
| `ui/listen.js` | The ear: recognition, settle window, carry across recogniser seams, barge-in |
| `workIndex.ts` / `workItems.ts` / `plansReader.ts` | The work contract and its built-in reader |
| `planName.ts` | ⚠ The one plan-file writer — `name:` on rename, nothing else |
| `pins.ts` / `repoWeb.ts` / `handoff.ts` | Shelf, GitHub links resolved at click, terminal handoff |
| `personal.ts` / `greeting.ts` | Memory of the person; the boot line and the onboarding offer |
| `testRunner.ts` | Detect, settle, run, parse failures |
| `directorRole.ts` / `directorName.ts` | Shadow vs director; what to call her |
| `server.ts` / `bus.ts` / `eventlog.ts` / `state.ts` | Transport, replay, events, queues |
| `keyterms.ts` / `links.ts` / `markdown.ts` / `activity.ts` | Vocabulary, file links as offsets, span overlays, activity lines |

`docs/` holds design records — the reasoning behind the voice plane, the status
surface, personal context, the plans panel, and `/director-skills` — written so
a fresh session can pick the work up without the conversation that produced it.

## Machine gotcha

My default `node` is x64 under Rosetta, so the SDK's bundled Bun CLI hangs
silently ("CPU lacks AVX support" on stderr is the only tell). Every session
passes `pathToClaudeCodeExecutable` pointing at the native arm64 install —
`HARNESS_CLAUDE_BIN` if yours lives elsewhere.
