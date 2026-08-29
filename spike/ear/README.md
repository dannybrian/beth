# The ear spike — Scribe v2 realtime, measured

Step 1 of `docs/ear.md`, run 2026-08-29 against the real service. `node
spike/ear/run.ts` reproduces it (cents of TTS + STT). The test audio is
ElevenLabs' own TTS reading a script chosen to exercise exactly what the Web
Speech path cannot do — so the round trip needed no microphone and no human.

## Findings

1. **No `ws` dependency. Node's native `WebSocket` works.** Auth is a single-use
   token minted over HTTPS — `POST /v1/single-use-token/realtime_scribe` with the
   `xi-api-key` header, response `{"token":"sutkn_…"}` — passed as a `?token=`
   query param. The harness mints per session; the key never meets a websocket.
   (The other documented endpoint, `/v1/speech-to-text/get-realtime-token`, was
   not needed.) The existing key already has the permission: minting worked with
   no ElevenLabs console changes.

2. **Keyterms work, and they are the whole ballgame.** Same audio, two runs:

   |  | committed transcript |
   | --- | --- |
   | with keyterms | `Let's check the settle period. Does pnpm work with colyseus? Open beadgame, then run the tests.` |
   | without | `Let's check the settle period. Does PNPM work with Coliseus? Open bead game, then run the tests.` |

   With the vocabulary in, the round trip is VERBATIM — punctuation, question
   mark, casing, and every project noun. Without it, the nouns fail in exactly
   the shape reported from use ("Coliseus" is "colossus" again).

   ⚠️ Encoding: **repeated query params** (`keyterms=pnpm&keyterms=colyseus`), not
   a JSON array — the array arrives as ONE keyterm and trips the limit. And each
   keyterm is capped at **20 characters**; the assembly in `keyterms.ts` must
   enforce that, because the error is fatal to the session, not a warning.

3. **Punctuation is native and "the settle period" is safe.** The sentence the
   dictation table eats came through intact in every run, no rewrite rules
   involved.

4. **VAD commits arrive ~1.6s after speech ends**, matching the default config
   (`vad_silence_threshold_secs: 1.5`) that `session_started` echoes back. That
   beats today's 2.5s settle window and roughly matches the 1.2s final-segment
   fast path — and it is tunable at the handshake. Partials stream continuously
   (first at ~1.9s including session setup; `max_tokens_to_recompute: 5`, so
   they are append-mostly).

5. **Errors are FRAMES, not handshake failures.** The websocket OPENS even with
   a bad token; then a typed frame arrives (`auth_error`, `invalid_request`,
   with an `error` string) and the server closes (1008 for invalid request,
   1000 after auth_error). An `EarEngine` must therefore treat "open" as
   "transport up", not "session live" — `session_started` is the real go signal,
   and every error frame maps to `degraded` with its reason.

## Fixtures

Captured verbatim in `fixtures/` (received frames complete; sends recorded as
byte counts — they are base64 audio):

- `vad-keyterms-repeat.jsonl` — the canonical good run: `session_started` with
  full config echo, 9 partials, `committed_transcript`.
- `vad-plain.jsonl` — same, no keyterms (the mangled-nouns run).
- `vad-keyterms.jsonl` — the JSON-array mistake: `invalid_request` frame + 1008
  close. Real fixture for the fatal-config path.
- `auth-error.jsonl` — open, `auth_error` frame, close. Real fixture for the
  degraded path.
- `script-audio-pcm16k.raw` — the TTS audio (cached; delete to resynthesize).

## The shipped engine, verified live

`live-engine.ts` (added with step 2) replays the same TTS round trip through
the REAL `src/ear/scribeEngine.ts` — not spike code — and got the verbatim
commit with keyterms on. The fixtures here were copied to `src/ear/fixtures/`,
where the engine's tests replay them; this directory keeps the originals and
the capture script that can regenerate them.

## Not answered here

**Echo/duplex.** Whether AEC on our own capture is enough to skip half-duplex
parking needs a human, speakers up, in the room. The engine work does not block
on it — parking is the shipped default until measured.
