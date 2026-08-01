# director-harness

Conversational harness for the standing-director workflow. Phase 1 (text-only) of
`beadgame/plans/future/2026-07-31-director-conversational-harness.md`.

One instance binds to one repo. The director session runs with `cwd` = that repo, so
CLAUDE.md, skills, hooks, and `/plans` work exactly as they do in a terminal — the
harness only re-homes the director's input and output.

```bash
cd ~/Sources/beadgame && beth
```

`beth` binds to the git root you are standing in, picks a free port (so several
repos run side by side), starts the ngrok tunnel, opens the browser, and tears
everything down together on Ctrl-C. `beth --help` for flags; `--no-tunnel` and
`--no-open` opt out.

**The tunnel is no longer needed for voice.** Recognition happens in the browser
and her voice is streamed from the harness over loopback, so nothing dials in,
nothing public is opened, and nothing is billed while idle — `--no-tunnel` is now
the ordinary way to run. Set `HARNESS_BROWSER_STT=0` to go back to Speech Engine
(which does need the tunnel) while the old path is still there. See
`docs/voice-plane.md`.

Install the command once:

```bash
ln -sf ~/Sources/director-harness/bin/beth.mjs ~/.local/bin/beth
```

Or run the server directly, without the tunnel or port-picking:

```bash
node src/main.ts          # → http://localhost:4620
```

No build step (Node ≥ 23 strips types natively). Dependencies: the Claude Agent SDK and
zod. The UI is dependency-free vanilla DOM; the browser transport is SSE + POST because
Node has no built-in websocket *server* and the plan treats transport as incidental.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `HARNESS_REPO` | `~/Sources/beadgame` | Repo the instance binds to |
| `HARNESS_PORT` | `4620` | Set this to run a second instance alongside |
| `HARNESS_MODEL` | `claude-opus-5` | Director session model — the dominant cost lever |
| `HARNESS_CLAUDE_BIN` | `~/.local/bin/claude` | Native CLI (see gotcha below) |
| `HARNESS_DIRECTOR_PLAN` | `plans/2026-07-30-director-consolidation.md` | Plan whose live claim means a terminal director holds the role |
| `HARNESS_NO_KICKOFF` | — | Skip the opening turn (cheap boot for testing) |
| `ELEVENLABS_API_KEY` | — | Voice. Also read from the bound repo's `.env` |
| `SPEECH_ENGINE_ID` | — | Voice. `seng_…`, created in the ElevenLabs dashboard |
| `HARNESS_AUDIO_TAGS` | `1` | Set `0` if the engine's model can't read v3 audio tags |

Per-repo state (the session id used for `resume`) lives in
`~/.director-harness/<repo-slug>/`. Nothing is machine-global, so instances don't collide.

## What's here

| Module | Owns |
|---|---|
| `session.ts` | The one long-lived streaming `query()`; turn pushes; result/usage reading; session-id persistence and `resume` across restarts |
| `askgate.ts` | `canUseTool` — AskUserQuestion rendered and **pended** until answered; every other gated tool becomes an approve/deny card |
| `tools.ts` | In-process MCP server: `say`, `queue_decision`, `pending` (all `alwaysLoad`) |
| `eventlog.ts` | Append + tail `<repo>/.claude/events.jsonl` (gitignored) |
| `state.ts` | Live Ask-Danny queue and worker roster |
| `bus.ts` | Ordered event flow to the UI, with replay for late-connecting browsers |
| `server.ts` | Static UI, SSE stream, POST endpoints |
| `directorRole.ts` | Handoff policy — shadow vs director, never `claim --force` over a live peer |
| `voice.ts` | Speech Engine attach, transcript→turn bridge, barge-in→`interrupt()`, cost meter |
| `audioTags.ts` | Vocalization — tags spoken, stripped from displayed text |
| `ui/voice.js` | Demand-scoped voice client: off → armed (free local VAD) → connected (billed) |

## Voice

Speech Engine bills **connection duration**, not audio processed — roughly $0.24/hour even
idle. So the paid session is demand-scoped: **armed** runs a free local Web Audio VAD in
the page, and only promotes to a **connected** (billed) session once you actually start
talking. 45 s of silence closes it again. The toggle colours free and billed differently
on purpose, and the status strip carries a running cost.

Voice needs `ELEVENLABS_API_KEY` and a Speech Engine (`SPEECH_ENGINE_ID`). Without them
the harness runs text-only and the toggle explains what's missing.

**Scoping the key.** ElevenLabs keys are restricted by default — you pick which products
they can reach, and can set a per-key monthly credit cap (and an IP allowlist). The
harness only ever calls **Speech Engine** and the conversation-token endpoint used to mint
the browser's WebRTC token; speech-to-text and text-to-speech happen *inside* the Speech
Engine session, so the key does not need direct TTS or STT access. Enable Speech Engine
and Conversational AI / Agents, set a credit cap, and leave everything else off. If token
minting 403s, Conversational AI is the scope to widen.

The director may use inline audio tags — `[laughs]`, `[sighs]`, `[dryly]` — which are
spoken but stripped from the text you read. If the engine's TTS model doesn't support v3
audio tags, set `HARNESS_AUDIO_TAGS=0` and they're stripped from the voice path too.

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

Voice (Phase 2 — speech provider reopened in favour of Replicate Kokoro/Whisper on cost),
richer event surfaces and terminal-hook event writers (Phase 3), adapter extraction
(Phase 4). `startup()` warm-starting is deliberately skipped until voice makes latency
matter.
