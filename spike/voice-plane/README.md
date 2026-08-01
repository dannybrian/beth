# voice-plane spike

Step 1 of [`docs/voice-plane.md`](../../docs/voice-plane.md). **Throwaway** — its own
port, its own server, no imports from `src/` and nothing in `src/` imports it. Delete the
directory once the questions below have answers.

```bash
node spike/voice-plane/serve.mjs
```

Then open <http://127.0.0.1:4630> in **Chrome** (Web Speech API is Chrome-only) and click
*Mic on*. Talk, wait for the settle window, listen to her come back. Speakers up — the
whole point is that the sound is in the room, not in headphones.

Flags: `--port 4630`, `--harness 4620`. Credentials come from the same three layers the
harness uses (real env → the bound repo's `.env` → `~/.director-harness/.env`), so if
`beth` has voice, this does too.

## What it is asking

**1. Does the mic hear her?** Set duplex to **open** and let her talk. Every red
`HEARD HERSELF` line is her voice arriving back through the recogniser — scored by word
overlap, so someone genuinely talking over her still reads as `over her` rather than as
echo. A high count in *open* is expected and is not the finding; the finding is what the
other two modes cost to fix it.

**2. Is an AEC'd RMS gate a usable barge-in trigger?** The fourth card reads two numbers.
*Echo floor* is the loudest the meter got **while she was speaking and you were silent** —
that is what Chrome's echo cancellation let through. *Your voice* is the loudest it got
while she was not. If the floor sits well below your voice, the threshold between them is
the barge-in detector, and `half + barge-in` is the shape to ship. If they overlap, the
gate will either miss interruptions or cut her off at random, and the real answer is a
push-to-talk key.

Note the asymmetry the page cannot get around: `SpeechRecognition` grabs its own
microphone and takes no constraints, so we can only ask for `echoCancellation` on **our**
capture. That is exactly why the barge-in gate runs on our stream and the recogniser is
parked, rather than the other way round.

**3. What does time-to-first-sound actually cost?** The first card measures request →
`playing` on the `<audio>` element: the number a listener experiences, not TTFB. The
server logs its own TTFB beside it. Compare with tonight's Speech Engine trace before
believing the migration is free.

## Modes

| duplex | what it does | what it is for |
| --- | --- | --- |
| `open` | recognition never stops | measures raw echo — the control |
| `half` | recognition stops while audio plays, resumes 300 ms after `ended` | the cheap fix; costs you the ability to interrupt |
| `half + barge-in` | as `half`, plus sustained RMS over threshold stops her mid-line | the proposed shape |

Replies default to **canned** on purpose: an echo test needs the same audio every time, and
a real reply varies, which means comparing two things at once. Switch to **live** — with
`beth` running — to see a real round trip; the page speaks `voiceText`, which is the same
excerpt `spoken.ts` already picks today.

## The verdict

**Run 2026-08-01, speakers up: she does not hear herself, and barge-in behaves.** That was
the question the page existed to answer, and it is a yes. Recognition quality is good;
Scribe reads well too. What follows is the rest of what the run turned up.

## What it has already found

**The key needed the Text to Speech permission.** The harness only ever needed the
*ElevenAgents* row, because Speech Engine does its own speaking inside the session; this
plane calls `textToSpeech.stream` directly. Added 2026-08-01 and TTS now answers — one more
permission in exchange for deleting the tunnel. (Add **Speech to Text** too if Scribe is on
the table — see *Punctuation*.)

**⚠ The engine's own TTS model is not available here.** `/config` reads the voice and model
off `seng_…` so the spike sounds like tonight's trace, and this engine runs
`eleven_v3_conversational` — which the standalone `/v1/text-to-speech/…/stream` endpoint
**rejects**. The server falls back to `eleven_flash_v2_5` once and logs it. The voice id is
the same, so she still sounds like herself, but the model is not, and that carries into the
design: **Flash predates v3 audio tags**, so the new plane has to strip them the way
`voice.ts` already does when it detects a non-v3 engine. The migration inherits the voice,
not the engine's speech settings.

**Time to first sound is not the problem.** Measured on the mp3 stream, 120 characters:

| | ttfb | complete |
| --- | --- | --- |
| cold (first request of the process) | 1164 ms | 1.39 s |
| warm | 160 ms | 0.38 s |

The cold number is connection setup and is paid once. 160 ms to first byte, with the
browser buffering the rest as it plays, is comfortably inside conversational latency — this
half of the migration costs nothing.

## Punctuation

The Web Speech API returns a flat run of words and has **no dictation mode** — "period"
arrives as the word. The *spoken punctuation* checkbox is a stopgap that rewrites
`period`, `comma`, `question mark`, `exclamation mark`, `colon`, `semicolon`, `dash`,
`open/close paren`, `new line` and `new paragraph`, then capitalises sentence starts.

The live line under the controls shows the **sent** form, not the heard one — the rewrite
happens as you speak, so a wrong one is visible before the turn goes rather than after. The
log records both, raw → punctuated.

⚠ It will eat a real *"how long is the settle period"* → *"How long is the settle."* That
is unavoidable with a word-substitution trick, and it is why the real answer is **Scribe**,
which punctuates properly. Scribe also fixes the deeper problem: we would own the
`MediaStream`, so `echoCancellation` would finally apply to the audio the recogniser
actually receives. Both of today's limits are the same limit — with the Web Speech API we
do not own the capture.

## Known in advance

- **Playback needs a gesture.** Chrome blocks autoplay until you have clicked the page;
  *Mic on* counts.
- **`no-speech` is ordinary.** Chrome ends a recognition session every time it times out in
  silence, and the page restarts it. Only other errors are logged.
- The harness proxy is loopback-to-loopback and must stay that way. Nothing here is
  tunnelled, which is the entire security argument for the new plane.
