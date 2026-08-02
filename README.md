# director-harness

Conversational harness for the standing-director workflow, from
`beadgame/plans/future/2026-07-31-director-conversational-harness.md`. Text and voice both
work; the voice plane is local end to end (see `docs/voice-plane.md`).

One instance binds to one repo. The director session runs with `cwd` = that repo, so
CLAUDE.md, skills, hooks, and `/plans` work exactly as they do in a terminal — the
harness only re-homes the director's input and output.

```bash
cd ~/Sources/beadgame && beth
```

`beth` binds to the git root you are standing in, picks a free port (so several
repos run side by side), opens the browser, and tears everything down on Ctrl-C.
`beth --help` for flags; `--no-open` opts out.

**Voice needs nothing but a key.** The browser recognises what you say and posts an
ordinary turn; her replies stream back as audio over loopback. Nothing dials in,
no tunnel, no public port, nothing billed while idle, and every repo can have
voice at once. Chrome only — the Web Speech API is not in Safari or Firefox. See
`docs/voice-plane.md` for how it got this way.

Install the command once:

```bash
ln -sf ~/Sources/director-harness/bin/beth.mjs ~/.local/bin/beth
```

Or run the server directly, without port-picking:

```bash
node src/main.ts          # → http://localhost:4620
```

No build step (Node ≥ 23 strips types natively). Dependencies: the Claude Agent SDK, zod,
and the ElevenLabs SDK for text-to-speech. The UI is dependency-free vanilla DOM; the
browser transport is SSE + POST, plus one HTTP audio stream.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `HARNESS_REPO` | `~/Sources/beadgame` | Repo the instance binds to |
| `HARNESS_PORT` | `4620` | Set this to run a second instance alongside |
| `HARNESS_MODEL` | `claude-opus-5` | Director session model — the dominant cost lever |
| `HARNESS_CLAUDE_BIN` | `~/.local/bin/claude` | Native CLI (see gotcha below) |
| `HARNESS_DIRECTOR_PLAN` | `plans/2026-07-30-director-consolidation.md` | Plan whose live claim means a terminal director holds the role |
| `HARNESS_NO_KICKOFF` | — | Skip the opening turn (cheap boot for testing) |
| `ELEVENLABS_API_KEY` | — | Voice. Needs the **Text to Speech** permission |
| `HARNESS_VOICE_ID` | — | Whose voice. Read off `SPEECH_ENGINE_ID` when unset |
| `HARNESS_TTS_MODEL` | `eleven_flash_v2_5` | ⚠ Flash predates v3 audio tags, so tags are stripped |
| `HARNESS_SPEECH_LEVEL` | `brief` | How much is read aloud — see `spoken.ts` |
| `HARNESS_VOICE_SETTLE_MS` | `2500` | How long the words must stop changing before a spoken turn sends |
| `HARNESS_TEST_CMD` | detected | Test command. ⚠ Running is off until enabled per repo |
| `HARNESS_PERSONAL` | on | `off` disables remembering the person entirely |

Per-repo state lives in `~/.director-harness/<repo-slug>/` — the session id used for
`resume`, whether the test monitor is enabled here, what she remembers about you, and the
last few things she opened with.
Nothing is machine-global except the credentials, so instances don't collide.

## What's here

| Module | Owns |
|---|---|
| `session.ts` | The one long-lived streaming `query()`; turn pushes; result/usage reading; session-id persistence and `resume` across restarts |
| `askgate.ts` | `canUseTool` — AskUserQuestion rendered and **pended** until answered; every other gated tool becomes an approve/deny card |
| `tools.ts` | In-process MCP server: `say`, `queue_decision`, `pending`, `plans`, `speech`, `remember`, `recall` (all `alwaysLoad`) |
| `eventlog.ts` | Append + tail `<repo>/.claude/events.jsonl` (gitignored) |
| `state.ts` | Live Ask-Danny queue and worker roster |
| `bus.ts` | Ordered event flow to the UI, with replay for late-connecting browsers |
| `server.ts` | Static UI, SSE stream, POST endpoints |
| `directorRole.ts` | Handoff policy — shadow vs director, never `claim --force` over a live peer |
| `speakOut.ts` | The speech plane: what to say (`spoken.ts`), held as a line, streamed as audio |
| `audioTags.ts` | Vocalization — tags spoken, stripped from displayed text |
| `ui/listen.js` | The ear: browser recognition, settle window, spoken punctuation, barge-in |
| `testRunner.ts` | Detects the project's test command, runs it when the tree settles, parses failures |
| `personal.ts` | What she remembers about Danny, and the once-a-day rule for when she may ask |
| `greeting.ts` | The boot line: the last few openings to avoid, and the facts to be specific about |

## Voice

Two halves, both local.

**She hears you** through the browser's own recogniser (`ui/listen.js`), which posts an
ordinary turn to `/api/turn` — so a spoken turn carries the plans you pointed at and
honours `/clear` and `/stop` exactly like a typed one. The composer shows the words
arriving, punctuated as they will be sent. Chrome only.

**She speaks** by holding each line server-side and streaming it as mp3 from
`/api/voice/say/<id>` into an `<audio>` element (`src/speakOut.ts`). That means she can
speak the moment she has something to say — no session to open, nothing to answer, and no
mic required. Time to first sound is about 160 ms warm.

The ear parks while she talks, because echo cancellation cannot reach Chrome's recogniser
(it opens its own microphone and takes no constraints). Interruption comes back via an RMS
gate on our own echo-cancelled stream: talk over her and she stops.

Voice needs `ELEVENLABS_API_KEY` with the **Text to Speech** permission, and a voice —
`HARNESS_VOICE_ID`, or a `SPEECH_ENGINE_ID` to read one off. Without them the harness runs
text-only and the mic button explains what is missing.

How much of what she writes is read aloud is a level — `full`, `brief`, `headlines`, `off`
— set by `HARNESS_SPEECH_LEVEL`, by the dropdown in the strip, or **by asking her**: "stop
talking", "just the headlines", "you can talk again" all reach the `speech` tool and move
the same dial the dropdown does. Every level leaves the transcript untouched; only the
pronunciation is reduced.

She may use inline audio tags — `[laughs]`, `[sighs]`, `[dryly]` — which are stripped from
the text you read. ⚠ They are stripped from the *speech* too unless `HARNESS_TTS_MODEL`
names a v3 model, because the default realtime model predates them.

## Tests

The top right answers "is the tree green". The command is **detected** from what the
project already declares — `package.json` `scripts.test` (using the package manager it
names), `*.csproj`, `Cargo.toml`, `go.mod`, `pyproject.toml`, a `Makefile` `test:` target
— and `HARNESS_TEST_CMD` overrides all of it. The harness never invents one.

⚠ **Off until you enable it, once per repo.** Clicking the light shows the detected command
before offering the switch, because this executes project code on a schedule and a suite
that spins containers or costs money must not start because you saved a file.

It runs only when the tree has **changed**, has **settled**, and she is **idle** — she runs
her own suite during a turn, and two on one tree produce failures belonging to neither.
Green means passed and unchanged since; yellow means running, or passed-but-stale; red
carries the count.

Clicking a failure drops a **chip** in the composer rather than pasting a stack trace —
the same gesture as clicking a plan, so she gets a name she can say out loud with the file,
line and assertion underneath.

## Personal context

She remembers the person, not only the work — `remember` and `recall`, in
`~/.director-harness/<repo>/personal.jsonl` (append-only, never in the repo).

The value is entirely in the **follow-up**, so the rule is that she may only ask about
something she actually knows: a question comes from a recorded fact with a date on it, or
it does not get asked. At most one personal beat a day, only at a moment already hers —
the boot greeting, or the first turn after a long gap — never mid-work. Most days that is
silence, which is correct.

`HARNESS_PERSONAL=off` disables it completely: the tools are not registered, nothing is
recorded, nothing rides the prompt. Someone turning this off is saying don't keep a file on
me, not "ask me less often".

## The boot greeting

One sentence, written by her, spoken as she comes up. It was always model-written and it
was always the same sentence, because every boot handed her identical inputs and a fresh
session cannot know what it said yesterday. So `greeting.ts` gives it the two things it
was missing: the last six openings, with "not these", kept in
`~/.director-harness/<repo>/greetings.json`; and something to be specific about — branch,
uncommitted count, last commit and its age, what is in flight, the local clock, and how
long since she was last up. A restart ninety seconds later gets a different greeting than
an arrival the next morning, because it *is* a different morning.

The facts are also a saving: she used to spend a git tool call learning the branch before
the first word. `HARNESS_NO_KICKOFF=1` boots her silently and records nothing.

## Director-role handoff

The harness reads `<repo>/.claude/sessions/*.json` at startup. If a live session
(heartbeat < 4h) holds the director plan, the harness runs **shadow**: claimless, no
resume ritual, read-everything. Otherwise the role is **free**, and promotion is still a
deliberate act — `POST /api/promote` re-checks at that moment and refuses if a peer
claimed meanwhile. The harness never writes plan state itself; the director session does
that through `/plans` as usual.

## Machine gotcha

Danny's default `node` is x64 under Rosetta, so the SDK's bundled Bun CLI hangs silently
("CPU lacks AVX support" on stderr is the only tell). Every session passes
`pathToClaudeCodeExecutable` pointing at the native arm64 install.

## Not yet (later phases)

Richer event surfaces and terminal-hook event writers (Phase 3), adapter extraction
(Phase 4). Voice landed — see `docs/voice-plane.md`, which ends on the one open question:
whether to move recognition to Scribe for real punctuation.
