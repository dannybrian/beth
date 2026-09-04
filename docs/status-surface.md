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

⚠ CORRECTION (2026-09-01): `HARNESS_TEST_CMD` no longer overrides *all* of it. The gear
panel (`settings.ts`, a `settings.json` in the per-repo state dir) is a fourth layer and
it WINS over the env layers and over detection — deliberately, because a command typed
into the page that silently lost to a repo `.env` would be a no-op with no symptom. The
panel says which layer is in force, and clearing the field hands the command back to the
env layer and then to the detectors. Everything else in this section stands, including
the never-invents rule.

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

⚠ Read that gate as belonging to the SCHEDULE, not to the corner of the screen
(2026-09-01). The build light that now sits beside this one has deliberately the inverse
contract — no enable gate and no schedule — because a build only ever runs when Danny
presses it, and the press IS the authorisation. What needs the gate is code running
because a file was saved.

### What it shows

Top right, where the numbers used to be: a dot and a count.

- **green** — last run passed, tree unchanged since
- **yellow** — running, or passed-but-stale (tree changed, next run pending)
- **red** — failures, with the count
- **grey** — not enabled here, or no runner detected

The same light is painted into the TAB TITLE (2026-09-01), which is the only part of the
page you can read while looking at something else — the whole reason the light is worth
having when the window is behind your editor.

Clicking opens the log panel: the command, when it ran, how long it took, exit code, and
the output. Failures are parsed into a list where they exist — `node --test` gives TAP-ish
`not ok` lines with a file and line; `dotnet test` and `pytest` have their own shapes — and
anything unparsed falls back to the raw log, which is still better than nothing.

### Clicking a failure

This is the same gesture as clicking a plan, and it should reuse the same machinery:
a failing test is a **reference pair** (`workItems.ts` shape — a spoken name and a path),
so clicking it drops a chip into the composer rather than pasting a wall of stack trace.
She then gets "the settle-window test in listen.test.ts" as something she can say out loud,
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
2. ~~Stats behind the context meter~~ — **done**. The meter left the busy-only
   progress cluster and became a always-visible clickable gauge in the composer; the
   strip's run-on sentence of numbers is gone entirely, so the top right is free. ⚠
   CORRECTION (2026-09-01): the top right is no longer free, and that was a deliberate
   reversal rather than drift. Two usage METERS came back to the strip (five-hour and
   seven-day) because 5h at 100% is the moment credits start draining, which is the one
   number worth answering without a click; the panel still renders every window. The
   corner now also holds the model, the effort select, a BUILD light beside the test
   light, and the gear. Anything added there is competing for a full shelf. The
   panel carries context, this turn, this session, the model, and the plan windows —
   `GET /api/usage`, feature-detected and caught, rendering only the windows actually
   present (five-hour, seven-day, and `model_scoped` per-model). Both honest absences —
   an API-key session, or a future SDK that drops the method — read as "no plan windows
   for this session", because neither is an error and neither is actionable differently.
3. ~~The test monitor~~ — **done**, all four parts. `src/testRunner.ts` detects, schedules,
   runs and parses; the light and panel are in the strip; a failure is a `WorkRef` of kind
   `'test'`, so clicking it uses the plan machinery unchanged.

   Two things the build taught that the design did not know. **Every parser runs and the
   richest result wins** — guessing the format from the command is confidently wrong when
   a project's `test` script is a wrapper, which is common. And `node --test` names each
   failure TWICE, once bare in the run and again in a "failing tests:" section carrying the
   actual error, so results are deduped by name keeping the richest; the invented fixture
   passed while real output produced three entries for one failure. Real output is now the
   fixture. (Also: resolve paths through `realpath`, or a repo reached via a symlink —
   /tmp, any worktree — reports one root while the output prints the other.)

   Superseded from the plan below: the old
   four-part ordering. Each part was useful on its own, and the last one is the one that
   turns a status light into a way of talking about the failure.


## Dated correction — 2026-09-01

The panel moved to the TOP. This record says the numbers live "behind the context
meter" at the bottom; they now live behind the top-right meters, and `.stats`
anchors to `top: 44px`. The bottom gauge stays and opens the same panel in the
same place — two doors, one room. The strip's meter row grew a third bar for
session context, which unlike the two plan windows is never hidden: every session
has a context, so it is what keeps the meter button on screen when there is no
plan to report.

## Dated correction — 2026-09-04

`turnInFlight` is only as true as the `thinking` status that feeds it, and that
status used to be published in ONE place: the session's `send()`. A turn is not
always Danny's. When a worker reports back, the SDK resumes the model on its own,
nothing calls `send()`, and for the whole of that turn the spinner stayed hidden —
on the page and on the terminal's status line, which reads the same message.
Seen from use with three harnesses mid-turn and one spinner between them.

The session now treats the prediction itself as the proof: the first
`stream_event` or `assistant` message with no `thinking` outstanding publishes
one, whoever started the turn, and the `result` closes it as before
(`session.ts`, the `thinking` flag). The dot/spinner split above is unchanged;
what changed is that the spinner's input is now the stream, not the send.
