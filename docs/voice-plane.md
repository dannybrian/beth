# The voice plane — leaving Speech Engine

> Danny, 2026-08-01: *"I'm starting to wonder if Speech Engine is still better for us
> than TTS straight up, and doing STT in the browser instead… we're gonna simplify and
> the latency is fine. What we're doing just doesn't fit the Speech Engine architecture."*

Decided. This records what forced it, what the new shape is, and what gets deleted —
because the deletions are most of the argument.

## What forced it

**She can never speak first.** Speech Engine will only carry a response to something it
HEARD. Both documented routes out were tried against the real service on 2026-08-01 and
both failed:

- `conversation.sendUserMessage(text)` — the client genuinely puts `{type:"user_message"}`
  on the data channel. ElevenLabs never converts it into a `user_transcript` for a
  bring-your-own-LLM engine, so the harness has nothing to answer.
- `overrides.agent.firstMessage` — the mechanism their own SDK warning recommends. A
  Speech Engine **rejects** the `conversation_initiation_client_data` override:
  *"Server error: Unknown error"*, DataChannel errors on lossy and reliable, room torn
  down before it ever reached our websocket.

That is fatal here, because outbound speech is the premise. The persona instructs her to
say what she is about to do and to close the loop out loud; the `say` tool exists to
announce things while work runs. On Speech Engine every one of those lines waits for a
transcript — 6 to 14 seconds for the recogniser to remark on an empty room, and never at
all if the mic is muted. Everything in `voice.ts` around the announcement queue is
scaffolding built around that hole.

## What it costs beyond the hole

Almost every hard-won gotcha in CLAUDE.md exists because **ElevenLabs dials IN to us**:

- a second public listener, a JWT-verified upgrade path, and "only ever tunnel the voice
  port" as a standing rule — an internet-facing surface on a local tool
- the ngrok dependency, a rotating hostname, and re-registering `wsUrl` at every boot
- **voice as a machine singleton** — one engine, one stored `wsUrl`, one tunnel host — so
  two repos can never both have voice, which caused the two-instance confusion and the
  4621 port collision
- connection-duration billing at $0.08/min, hence demand-scoped sessions, idle windows, a
  cost meter, and a running argument about how long to hold a channel nobody is in
- one response per transcript, ended by `is_final` — hence one serialised speak chain, the
  backlog riding the next turn, and a mandatory ack when a level would otherwise be silent

None of it is conversation logic. It is all transport tax.

## The new shape

```
  mic → browser STT ─POST /api/turn→ harness ─┐
                                              │  (the director session, unchanged)
  speakers ← <audio> ←── GET /api/voice/say ──┘   server-side TTS stream
```

**In.** The browser recognises speech and posts text to `/api/turn`, which already exists
and already carries typed turns, pointing references and all. The settle window
(`HARNESS_VOICE_SETTLE_MS`, now 2500 ms) moves to the page and keeps doing exactly what it
does now: wait for the transcript to stop changing, then send ONE turn.

**Out.** `textToSpeech.stream(voiceId, …)` in the SDK we already depend on returns a
`ReadableStream<Uint8Array>`. The harness holds a spoken-line queue; each line gets an id;
the page plays `new Audio('/api/voice/say/<id>')`. HTTP streaming into an `<audio>`
element gets browser-native buffering for free and needs no new transport — the existing
SSE only has to carry "there is a line to play, here is its id".

She therefore speaks **whenever she wants**, with no session to open, no transcript to
answer, and no mic involved. The queue, the re-queue, the staleness window, the ack, the
nudge scaffolding — all unnecessary.

## What survives, what goes

**Survives untouched**, because it was always ours rather than theirs: the settle window,
the speech levels and last-paragraph excerpt (`spoken.ts`), the audio-tag stripping, the
markdown/links overlays, `sendPointed`, the cost display, the whole director session.

**Deleted:**

| Gone | Because |
| --- | --- |
| the voice port, `/healthz`, the JWT upgrade path | nothing dials in |
| the tunnel, `HARNESS_PUBLIC_WS_URL`, boot-time `wsUrl` re-registration | same |
| voice-is-a-singleton, and the instance warnings around it | every repo can have voice at once |
| the announcement queue, staleness, re-queue, `speakable` | she can just speak |
| `SILENT_ACK`, "never return zero chunks", the re-delivery loop | no transcript to leave unanswered |
| `speechEngine.attach`, `SpeechEngineSession`, `sendResponse` chaining | replaced by an audio stream |
| connection-duration cost meter | billing is per character now |

Net: the voice plane gets smaller, and the security story becomes "everything is on
loopback", which also makes the shell-executing handoff unambiguously safe.

## The two real risks

**1. Barge-in and echo — the one thing Speech Engine genuinely did for us.** With an open
mic and speakers, the recogniser will happily transcribe HER. That is the television
problem, self-inflicted. Three defences, cheap and stacking:

> **Settled, 2026-08-01, in the spike with the speakers up: she does not hear herself, and
> barge-in behaves.** This was the risk that could have sunk the migration, and it did not.
> The three defences below are enough, and the fifteen lines were fifteen lines.

- `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })` — the
  browser's AEC is built for exactly speaker-into-mic. ⚠ But it does **not** reach the
  Web Speech API recogniser, which opens its own capture and accepts no constraints. This
  cleans the stream the barge-in gate runs on, and nothing else,
- pause recognition while audio is playing, resume on `ended`,
- reuse the RMS meter already in `ui/voice.js` as a barge-in detector: sustained energy
  while she is speaking stops playback and starts listening. That is the interruption
  behaviour we lose, rebuilt in about fifteen lines — and unlike theirs, we decide what
  counts as an interruption.

**2. Which STT.** `webkitSpeechRecognition` is free, built in, and continuous, but Chrome
ships the audio to Google — worth stating out loud rather than discovering. Scribe
(`speechToText.convert`, same SDK) keeps it inside the account we already pay, at roughly
half a cent a minute. A local whisper is the private option at ~100–300 MB. Start with the
Web Speech API because it costs nothing to try, and keep the recogniser behind a small
interface so swapping it is a file, not a rewrite.

**Tried, 2026-08-01.** Recognition itself is good — it hears him accurately. Two things
it cannot do, and they are the same thing twice:

- **No punctuation, and no way to dictate it.** Chrome returns a flat run of words and has
  no dictation mode, so "period" arrives as the word "period". The spike ships a spoken-
  punctuation rewrite as a stopgap; it works, and it also eats a real "the settle period",
  which is exactly why it is a checkbox and not the answer.
- **Echo cancellation cannot reach it.** It opens its own microphone and accepts no
  constraints, so `getUserMedia({ echoCancellation: true })` cleans a stream the recogniser
  never sees.

Both follow from the same root: with the Web Speech API **we do not own the capture**.
Scribe reverses that — we hold the `MediaStream`, so AEC applies to the audio the
recogniser actually gets, and Scribe punctuates properly on its own. The cost is a
`MediaRecorder` and chunk-posting loop we would otherwise not write, plus half a cent a
minute and the `speech_to_text` permission. That now looks like the better trade, but the
echo numbers from the spike decide it: if parking the ear turns out to be enough, owning
the capture buys only punctuation.

## Cost

Speech Engine bills $0.08/min **connected**: about $4.80 for an hour of real conversation,
and $0.24/hr for one merely held open. Per-character TTS for the same hour — she speaks in
short lines, a few thousand characters — lands nearer a dollar, and an idle harness costs
exactly nothing. Numbers depend on the plan, but the shape is: cheaper when talking,
free when not, and no reason to ever hang up.

## Order

1. **Spike, half a day.** BUILT — `spike/voice-plane/`, its own server on 4630, no
   imports either way. Web Speech API → `/api/turn`, one endpoint streaming TTS back,
   three duplex modes (open / half / half+barge-in) and a meter that separates the
   *echo floor* Chrome's AEC lets through from your own voice. Three findings already,
   before anyone has listened to the echo:

   - the key needed the **`text_to_speech`** permission, because Speech Engine never did
     the speaking through it. Added; one checkbox in exchange for deleting the tunnel.
   - **time to first sound is 160 ms warm** (1.16 s on the first request of a process,
     which is connection setup). Outbound latency is a non-issue.
   - **the engine's TTS model is not reachable from the standalone endpoint.**
     `eleven_v3_conversational` is rejected; the spike falls back to `eleven_flash_v2_5`.
     Same voice, different model — and Flash predates v3 audio tags, so the new plane must
     strip them. The migration inherits the VOICE, not the engine's speech settings.

   One asymmetry the spike surfaced that the design above assumed away:
   `SpeechRecognition` grabs its own microphone and **takes no constraints**, so
   `getUserMedia({ echoCancellation: true })` can only clean up *our* capture. Defence
   one therefore does not protect the recogniser at all — it protects the barge-in gate.
   That makes parking the ear during playback load-bearing rather than optional, and
   makes the RMS gate the only way interruption survives. Worth knowing before step 3.
2. **Speak-out first, while Speech Engine still handles input.** BUILT — `src/speakOut.ts`,
   `GET /api/voice/say/<id>`, and a serial player in `ui/app.js`. A line she writes is held
   server-side, published to the page as an id, and streamed as mp3 into an `<audio>`
   element. **She speaks the moment she has something to say**: no session to open, no
   transcript to answer, no mic, no `speak-request`, no staleness window.

   Deliberately NOT part of `VoiceService`: it needs none of Speech Engine, the tunnel, the
   public port or an armed mic, and it is what survives when those go. Transcript-driven
   turns still answer through Speech Engine (`turnActive` keeps them from being spoken
   twice), which is what makes this step land on its own.

   Two things worth carrying forward: the voice id is INHERITED from the engine so both
   paths sound like the same person, and the model deliberately is not — which means audio
   tags are stripped on this path (`eleven_flash_v2_5` predates them). `HARNESS_SPEAK_OUT=0`
   goes back to waiting.
3. **Swap input over**, move the settle window into the page, and delete the queue,
   `speakable`, and the ack with it.
4. **Tear out the transport tax** — voice port, tunnel, singleton, cost meter — and
   simplify `beth` to a single local server.

Steps 2 and 3 each leave the harness working. Step 4 is pure deletion, which is the point.
