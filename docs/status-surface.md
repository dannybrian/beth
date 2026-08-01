# The status surface — what the top of the page is for

> Danny, 2026-08-01: *"the flashing green icon at the UI top should be flashing while any
> operations/workers are in progress; and our new spinner is better for the prediction
> still being in progress… the harness checks for tests — pnpm test, dotnet test, etc —
> and automatically runs them on a set timer, giving a green/yellow/red indicator at the
> top right (we could ditch a lot of the stats mess that's there now). Clicking it shows
> the test log; clicking a test posts it to the chat text input… I don't care if the
> context meter stays below, and clicking that is what shows all the stats; then test
> monitors can take the top right."*

Three changes that look separate and are not. The strip currently spends its most valuable
real estate — the top right, the thing you see without looking — on a run-on sentence of
numbers that answers a question nobody asks mid-conversation. Meanwhile the question you
*do* ask twenty times a day, "is the tree green", is not on the page at all.

So: the strip becomes a health light, and the numbers move behind a click.

## 1. Two signals, two meanings

Today the status dot pulses on `thinking` and the composer spinner shows while a turn is
in flight **or** a worker is running. They overlap, which means neither is a reliable
answer to anything.

Split them by scope:

- **The dot (top left) — is ANYTHING running for her.** A turn, a background worker, a
  queued ask waiting on you. It is the glance you take from across the room.
- **The spinner (composer) — is SHE thinking right now.** The prediction in flight, with
  its timer. It sits next to the input because that is where you are when you want to
  know whether to keep typing.

Concretely: `turnInFlight` drives the spinner; `turnInFlight || workersRunning` drives the
dot. Two lines of change in `ui/app.js`, and the two indicators stop lying about each
other. The timer stays with the spinner and keeps counting the composite busy state, which
is what it already does.

## 2. The test monitor

### Finding the command

Project-agnostic, the same way work readers are: the harness DETECTS, the project DECIDES.
A small ordered list of detectors, first hit wins:

| Signal | Command |
| --- | --- |
| `package.json` with `scripts.test` | the package manager it declares (`pnpm`/`npm`/`yarn`) |
| `*.sln` or `*.csproj` | `dotnet test` |
| `Cargo.toml` | `cargo test` |
| `go.mod` | `go test ./...` |
| `pyproject.toml` / `pytest.ini` | `pytest` |
| `Makefile` with a `test:` target | `make test` |

`HARNESS_TEST_CMD` in the bound repo's `.env` overrides all of it, and is the only thing
that runs for a repo the detectors do not recognise. **The harness never invents a
command** — it runs what the project already declares, because a guessed command is a
shell execution nobody authorised.

### When it runs

Not on a naked timer. A timer alone re-runs an unchanged tree forever, burns battery, and
tells you nothing you did not know a minute ago. The rule is *changed, settled, and idle*:

- the working tree has changed since the last run (cheap hash of `git status --short`
  plus mtimes; the work index already watches files, so this is the same machinery),
- nothing has been written for `HARNESS_TEST_SETTLE_MS` (default 5s) — a suite run
  against a half-finished edit is a red light that means nothing,
- **and the director is idle.** She runs her own `pnpm test` during a turn; two suites
  racing on one tree produce failures that belong to neither.

Plus a floor (`HARNESS_TEST_MIN_INTERVAL_MS`, default 2 min) so a rapid series of saves
does not queue a run per keystroke, and a ceiling on runtime after which the run is killed
and reported as timed out rather than left hanging.

⚠️ This executes project code on a schedule without anyone asking. That is a real hazard —
a suite that touches the network, spins a container, or costs money must not start because
you happened to save a file. So it is **off until enabled once per repo**, persisted in
the harness state dir, with the detected command shown before you enable it.

### What it shows

Top right, where the numbers used to be: a dot and a count.

- **green** — last run passed, tree unchanged since
- **yellow** — running, or passed-but-stale (tree changed, next run pending)
- **red** — failures, with the count
- **grey** — not enabled here, or no runner detected

Clicking opens the log panel: the command, when it ran, how long it took, exit code, and
the output. Failures are parsed into a list where they exist — `node --test` gives TAP-ish
`not ok` lines with a file and line; `dotnet test` and `pytest` have their own shapes — and
anything unparsed falls back to the raw log, which is still better than nothing.

### Clicking a failure

This is the same gesture as clicking a plan, and it should reuse the same machinery:
a failing test is a **reference pair** (`workItems.ts` shape — a spoken name and a path),
so clicking it drops a chip into the composer rather than pasting a wall of stack trace.
She then gets "the settle-window test in voice.test.ts" as something she can say out loud,
with the file and line underneath — and the failure text as context on the turn.

Deixis was the unlock for plans. It is the same unlock here.

## 3. The stats, behind the meter

The context meter already exists in the composer progress cluster. Two changes:

- it stays visible when idle rather than only while busy (it is a gauge, not an activity
  light), and
- clicking it opens the panel that the strip's text is today: context tokens against the
  window, turn in/out/cached, turn cost, session cost, model.

And the thing that makes this worth building rather than merely rearranging — **plan usage
windows**. The SDK exposes them:

```ts
q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
// → { subscription_type, model_usage,
//     rate_limits_available: boolean,
//     rate_limits: { five_hour?, seven_day?, seven_day_opus?, seven_day_sonnet?,
//                    model_scoped?: […] } }   // each: utilization, resets_at
```

Five-hour and seven-day windows come back directly; the per-model weekly figures (Fable
included) arrive through `model_scoped`, which the SDK documents as additive and
server-driven — so read it defensively and render only the windows that are actually
present. `rate_limits_available` is false for API-key, Bedrock and Vertex sessions, and
the method name is an explicit warning: wrap the call, feature-detect it, catch
everything, and degrade to the local numbers when it is gone. It must never be the reason
the panel fails to open.

## Order

1. ~~The dot/spinner split~~ — **done**. The dot pulses on `turnInFlight ||
   workersRunning || decisionsWaiting` and carries the reason as its title; the
   composer spinner shows only while the prediction is in flight, and the timer
   beside it still counts the composite state.
2. Stats behind the context meter — frees the top right before anything needs it.
3. The test monitor — detector, then runner and light, then the log panel, then clickable
   failures. Each of those four is useful on its own, and the last one is the one that
   turns a status light into a way of talking about the failure.
