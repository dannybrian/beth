# The ear, owned — leaving the Web Speech API

> Danny, 2026-08-29: *"The more I use beth, the more I wish for a more reliable
> voice-to-text… Let's talk about how we might improve it to not require spoken
> punctuation."* And, deciding: *"I would like the work we are doing now — more
> intelligible speech input — to become as modular and tested as we can; I have use
> for it in other, in-progress projects. …I want all our underlying speech
> implementation to become this way, if/where they are not already; this part of
> the stack is valuable beyond beth."*

Decided. This records the design. `docs/voice-plane.md` holds the history — why the
browser recognises today, and why that path's two failings (no punctuation, echo
cancellation that never reaches the recogniser) are one fact twice: **we do not own
the capture**. Chrome opens its own microphone and takes no constraints, so there is
no tuning path out. The fix is a recogniser we feed audio to ourselves, and once we
are feeding audio ourselves, WHICH recogniser becomes a swappable detail.

Two requirements, and the second shapes the first:

1. **Punctuated, reliable speech input** with the project vocabulary biased in.
2. **The ear is a library.** Danny has other projects that want it. So the core is
   built to be lifted out — a directory with no imports from the harness, tested
   against stubs, with the harness reduced to one adapter on each side.

## The shape

```
  mic → getUserMedia (AEC on, and it finally applies) → AudioWorklet → 16k PCM
        │
        └─ POST /api/ear/audio ──→ harness ── EarEngine (Scribe websocket, or local)
                                       │
  composer ←── SSE `ear` events ───────┘   partials + commits, page stays the sender
```

**In.** The page captures its own stream — the same one the barge-in meter already
runs on — downsampled to 16 kHz mono PCM in an AudioWorklet (`MediaRecorder` gives
webm/opus, which no realtime STT wants). Chunks post to the loopback listener on a
short cadence. Because this is OUR capture, `echoCancellation: true` now cleans the
audio the recogniser actually hears — the asymmetry that made half-duplex parking
load-bearing is gone, or at least measurable.

**Recognition.** The harness holds the engine, because that is where the key belongs
(Scribe authenticates with a header a browser cannot set) and where a local engine's
process would live. The engine emits *partials* (best guess so far, punctuated) and
*commits* (the engine says the utterance ended — Scribe's server-side VAD, which
replaces the settle window with the thing the settle window was always a proxy for).

**Out.** Partials and commits ride the existing SSE as `ear` events. ⚠️ **The page
remains the sender.** The harness never turns a transcript into a turn; a commit
lands in the composer exactly where `onSettled` puts words today, and goes out
through the same `send()` — so pointing chips, `/clear`, `/stop`, the autosend
toggle, the hold-and-edit dictation mode, and the abandon control all keep working
without knowing anything changed underneath them.

## The module boundary

The extractable unit is three pieces, and the test of the boundary is that copying
them into another repo compiles:

- **`src/ear/`** — the engine interface, the Scribe engine, and the PCM math.
  No imports from the rest of the harness: no `config.ts`, no bus, no work index.
  Key, model, VAD tuning and keyterms are all injected. Node builtins only (plus
  possibly `ws` — see below).
- **`ui/capture.js`** — the worklet loader, downsampler wiring, chunk poster, and
  the arm/park/abandon state machine. Parameterised by endpoint; no `app.js`
  imports. The worklet's processor is a plain function in its own file, because
  that is the part with math in it and math is what node can test.
- **`ui/remoteEar.js`** — a class with the same surface as `Listener`
  (`arm`/`off`/`abandon`, `onState`/`onInterim`/`onSettled`), driven by SSE events
  instead of a recogniser. This is the page-side seam: `app.js` picks `Listener`
  or `RemoteEar` by flag and touches nothing else.

What stays OUTSIDE the boundary, deliberately: keyterm assembly (`keyterms.ts`
knows about plans and repos — a harness concern), the SSE publication, effort
ducking, the billing panel, and the mic button. Another project brings its own
versions of those; the ear does not know they exist.

Not a published package, for now — that is ceremony this repo adds only when
something hurts. Designed for lift-out means extraction is copying a directory,
not untangling one.

## The whole stack, not just the ear

The same standard applies to everything speech, because this part of the stack is
wanted beyond beth. An audit of where the mouth side already stands:

| Piece | State |
| --- | --- |
| `spoken.ts` (levels, excerpt) | clean — no imports, tested |
| `spokenName.ts` | clean — no imports, tested |
| `audioTags.ts` → `markdown.ts` | clean as a pair — the text pipeline lifts together, tested |
| `ui/speaker.js` (playback queue) | clean — stubbed `<audio>`, tested |
| `keyterms.ts` | deliberately NOT in the boundary — it knows about plans and repos |
| `src/speakOut.ts` | **the one entanglement** — imports `HarnessConfig` and publishes on the bus |

So "make the stack modular" is mostly ALREADY TRUE, and the remaining work is one
seam: split `speakOut.ts` into a core mouth — hold queue, TTS stream, voice/model
resolution, tag stripping, the character meter — that takes injected credentials
and an `onLine` callback, and a thin harness adapter that binds config and bus.
The existing `speakOut` tests (the whole speech plane, billing included) move to
the core and get SIMPLER, because the bus stub they currently need becomes a
callback.

End state, if it earns itself: a `speech/` directory whose contents another
project copies whole — mouth core, ear core, text pipeline, and the two browser
modules — with beth's adapters left behind. That reorganisation is cheap once the
seams are cut and pointless before, so the seams come first.

## The engine interface

```ts
export interface EarEngine {
  start(opts: EarSessionOpts): EarSession;
}

export interface EarSessionOpts {
  keyterms?: string[];                     // plain nouns; the engine biases how it can
  onPartial: (text: string) => void;       // punctuated best guess so far
  onCommit: (text: string) => void;        // the engine heard the utterance end
  onState: (state: 'starting' | 'live' | 'degraded' | 'closed', detail?: string) => void;
}

export interface EarSession {
  push(pcm: Int16Array): void;             // 16 kHz mono
  abandon(): void;                         // drop the utterance in flight, stay live
  close(): Promise<void>;
}
```

(No parameter properties — strip-only mode rejects them.)

`abandon()` carries the guarantee the current path fought for: **nothing already
heard may surface as a commit afterwards.** On Scribe that is discard-until-the-
next-VAD-boundary rather than a socket bounce; either way the contract is the
engine's to keep, and it is tested. The Stop/Escape ORDER gotcha from `listen.js`
maps straight across: abandon reaches the harness before the composer is cleared,
or the next partial renders the sentence right back.

`degraded` is the fallback signal, not an error: throttle, quota, session limits
and outages are documented Scribe payloads, and every one of them means "listen
the old way", never "the mic is dead".

## One ear

Mirror of "one mouth, however many tabs": two tabs both arming would mean two paid
Scribe sessions transcribing the same room. The harness holds ONE ear session;
arming in a second tab takes it over, and the loser's mic button reads why. The
ear follows the mic gesture the way `speak` follows focus — newest armer wins.

Effort ducking keeps its owner: arming still calls `/api/listening`, which still
calls `duckEffort`. Nothing about whose recogniser it is changes whose latency
budget a spoken conversation runs on.

## What retires, what stays

| Retires (on the new path) | Because |
| --- | --- |
| the settle window and both its constants | VAD commits measure what churn only implied |
| the spoken-punctuation table | the engine punctuates; "the settle period" is safe again |
| the biasing probe, `applyBiasing`, on-device checks | keyterms ride the session open, server-side |
| the recogniser restart loop and the `carry` fix | no recogniser dies mid-sentence to carry across |

| Stays | Because |
| --- | --- |
| `ui/listen.js`, whole and untouched | it IS the fallback — an ElevenLabs outage flips a flag, not a feature |
| the RMS barge-in meter | same stream, same fifteen lines; interruption is still ours to define |
| parking while she speaks, initially | AEC reaching the recogniser is measured before it is trusted — see open questions |
| autosend / hold-and-edit, abandon, `clearInterim` guard | they live above the seam and never learn it moved |
| `keyterms.ts` | the vocabulary was always harness knowledge; only the delivery changes |

## Failure and fallback

The `dropBiasing` philosophy, promoted one level: **the ear matters more than the
engine.** A `degraded` session reports once (not a silent downgrade), the page
swaps `RemoteEar` for `Listener` mid-conversation, and the mic stays hot. Coming
back is manual or next-arm, not a retry loop against a throttling service.

`HARNESS_EAR=scribe|browser` picks the path. `scribe` has been the default
since 2026-08-29 — the first real Chrome session worked, and Danny called it
earned the same day. `browser` remains byte-for-byte what it was: the opt-out,
the keyless degradation (guarded at `hello`, so a page is never offered an ear
that cannot arm), and the mid-conversation fallback.

## Billing

Same principle as the speech bill, same panel: **meter at the moment of spend.**
Seconds of audio are counted when chunks are FORWARDED to Scribe — parked audio
never leaves the machine and is never counted. Seconds are exact; the dollars are
an estimate (~$0.28–0.39/hr, keyterms a metered add-on), so the assumed rate is
printed beside the number, exactly as the TTS estimate is.

## Tests

The repo's criterion — test where a mistake is invisible — lands here hard,
because almost everything in this plane fails as "she heard him slightly wrong"
rather than as an error:

- **`ear/pcm.test.ts`** — the downsampler as pure math: 48k float → 16k int16,
  chunk boundaries, clipping, odd remainders. The worklet processor is this
  function; the browser part of it is just plumbing.
- **`ear/scribeEngine.test.ts`** — against an injected websocket stub: the
  session-open payload (model, VAD params, keyterms — all fifty, none silently
  truncated, and ⚠️ each ≤20 chars, because the spike showed an oversized
  keyterm KILLS the session with `invalid_request` rather than warning),
  partial/commit ordering, abandon discarding a commit already in flight,
  reconnect with text conditioning, `session_started` — not socket open — as
  the go signal, and every captured error frame mapping to `degraded` with its
  reason. ⚠️ Fixtures are REAL captured frames — they exist, in
  `spike/ear/fixtures/`, including a live `auth_error` and a fatal
  `invalid_request`, per the standing rule about invented fixtures.
- **`remoteEar` tests** — stubbed `EventSource` and fetch, the `wire.js`/
  `speaker.js` pattern: arm/steal/abandon ordering, the settle-less commit path,
  and that `off()` never emits — reaching for the mic is still a way OUT of a
  sentence.
- **`capture` state machine** — park stops the chunk flow (billing depends on
  it), unpark resumes cleanly, abandon-then-clear order.
- **the meter** — forwarded seconds only, and the rate printed, not hidden.

## Order

1. **Spike, half a day, in `spike/`.** DONE 2026-08-29 — `spike/ear/`, findings
   and verbatim frame fixtures in its README. The answers: **native `WebSocket`
   works** (auth is a single-use token from `POST /v1/single-use-token/
   realtime_scribe`, minted server-side, passed as `?token=` — `ws` stays
   deleted); keyterms ride as REPEATED query params, ≤20 chars each, and turn a
   mangled-nouns transcript verbatim; VAD commits land ~1.6s after speech ends
   (tunable, default 1.5s, echoed back in `session_started`); and errors arrive
   as typed FRAMES after a successful open, so `session_started` — not `open` —
   is the go signal. The echo half was NOT run (needs a human in the room); it
   stays an open question and blocks nothing.
2. **`src/ear/` with its tests.** DONE 2026-08-29 — `engine.ts`,
   `scribeEngine.ts`, and tests green against the captured fixtures
   (`src/ear/fixtures/`, copied in so the unit lifts with its proof). The
   shipped class was then run END TO END against the live service
   (`spike/ear/live-engine.ts`): same TTS round trip, VERBATIM commit.
3. **Capture and `RemoteEar`, behind `HARNESS_EAR=scribe`.** BUILT same day —
   `ui/pcm.js` + `ui/pcm-worklet.js` + `ui/capture.js` + `ui/remoteEar.js`,
   `src/earHost.ts`, the `/api/ear*` routes and the `ear` bus message.
   `listen.js` untouched; `degraded` swaps the browser ear in mid-conversation
   (app.js `onDegraded`). The node-testable halves are tested; the browser-only
   plumbing worked in the first real Chrome session (2026-08-29), and the
   DEFAULT flipped to `scribe` the same day on Danny's say-so —
   `HARNESS_EAR=browser` is now the opt-out rather than the other way round.
4. **Retire on the new path** — nothing punctuation- or settle-shaped exists on
   it to retire (the dictation table and settle window are Listener-internal
   and the fallback path keeps them), and the Listening bill renders in the
   stats panel beside Speech. Done by construction.
5. **The mouth seam** (independent, do whenever convenient): extract the
   `speakOut` core from its config/bus binding, move its tests onto the core.
   Pure refactor of a working plane — behaviour changes are a bug.
6. **Later, separately, if wanted:** a local engine behind the same interface.
   Kyutai STT is the one to spike first — streaming, punctuated, and its semantic
   VAD speaks this interface's `onCommit` natively. That it is a model download
   and a runtime is exactly why it is last and not first.

## Open questions

- **Full duplex.** With AEC finally reaching the recogniser's audio, parking may
  be unnecessary — but that needs a human, speakers up, in the room; the spike's
  automated runs could not measure it. The one thing voice-plane says Speech
  Engine genuinely did for us stays rebuilt-and-cautious until measured.
- **Whether VAD commits FEEL right.** The measured default is ~1.6s of silence
  to commit — already better than the 2.5s settle window. `vad_silence_threshold_secs`
  and friends are handshake params, injected precisely so tuning-by-use never
  touches the library.
- **Chunk cadence.** 250 ms POSTs on loopback should be nothing; if the overhead
  ever shows, a websocket upgrade on the SAME listener (same origin check —
  loopback stopped meaning local) is the fallback, recorded here so nobody
  reinvents a second port.
