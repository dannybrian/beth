# The desk — one page over the running directors

> Danny, 2026-09-03: *"I am wondering if I'm taking this too far up, ya know? If
> instead, just a UI that lets me switch between the running directors, with a minimal
> UI, would suit better, mirroring the conversation."* And, on the phone: *"the phone is
> the main issue, a responsive design here is likely a separate plan."*

Agreed, unbuilt (2026-09-03). This records the design so a fresh session can pick it up
without the conversation that produced it. Nothing here is started.

## What this is, and what it is not

Three or four directors run at once, each its own harness on its own port with its own
tab. The desk is ONE page over all of them: a bar of the running directors, the selected
one's conversation mirrored below it, a strip of everything waiting on Danny from any of
them, and every voice through one speaker. It reaches the phone through the same
Tailscale serve the single harness already uses.

It is not a session, not a model, and not a fifth director. It has no opinion and
reads nothing for him. The directors are unchanged except for one thing: each one now
announces that it is running. That is the whole of what they learn, which is nothing
about each other, and it is what keeps the harness project-agnostic while the desk
exists.

**Two designs were considered and set aside on the way here, and both should stay
set aside until use asks for them:**

- **One harness bound to several repos** — declined 2026-08-02 and not what this is.
  The desk multiplexes PAGES, not sessions; each director keeps its own repo, state
  dir, memory and voice.
- **An assistant director** — a fifth harness, bound to a desk repo, with tools to read
  every director's work and live state, a colleague channel to instruct a running
  director, authority to answer queued decisions, and a mute exemption so she speaks
  while they are silent. Discussed at length the same day. It answers a different
  want ("executing, synthesizing, keeping my need-to-know to a minimum") and needs a
  trust model to do it: a second principal on sessions that run shells, a director's
  guide deciding what it takes from a colleague, loops with money in them, her reading
  director output as data with Danny out of the loop. The desk is the substrate she
  would sit on — roster, proxy, summons — so building the desk first loses nothing.
  ⚠ Do not re-propose her from this paragraph. The signal that reopens her is Danny
  saying the READING is the pain, not the tabs.

## The shape

```
  ~/.director-harness/harnesses/<pid>.json     ← each harness announces itself (step 1)
              │
              ▼
  desk (127.0.0.1:<desk port>)                 ← one process, no session (step 2)
     ├─ /                      the existing ui/ with a director bar
     ├─ /d/<pid>/api/…  ─────► 127.0.0.1:<that harness's port>/api/…   (loopback proxy)
     ├─ /desk/roster           who is up, polled from the files
     └─ /desk/summons          every director's pending, pooled (step 3)

  page: selected director's stream rendered; every director's voice played (step 4)
```

The page is the page. `ui/` is served by the desk exactly as a harness serves it, so
the composer, panels, ear, mouth, wire, plan reader and every control keep working
against the selected director through the prefix. The desk adds a bar and a strip.

## 1. The roster

Each harness writes `~/.director-harness/harnesses/<pid>.json` when it starts
listening and unlinks it on exit:

```json
{ "pid": 12345, "port": 4621, "repo": "/Users/dbrian/Sources/beadgame",
  "director": "Beth", "startedAt": 1756900000000 }
```

The pattern is the voice room's (`src/voiceRoom.ts`): files in the machine dir,
because three browser origins share no channel and neither do three processes that
know nothing of each other. Named by pid so two harnesses never write one file.

- **Stale means provably dead** — the stick's rule, and its probe (`process.kill(pid,
  0)`). A reader ignores a dead entry and may unlink it. A harness killed with SIGKILL
  leaves its file; the pid probe is what makes that harmless.
- ⚠ **The harness announces; it never reads.** `directorName.ts` already knows the
  name and `config.ts` the port and repo, so this is a dozen lines in `main.ts` around
  `server.listen`. Nothing in a director consults the roster. That is the line the
  project-agnostic rule draws, and the desk is the only reader.
- ⚠ **Readers poll.** `fs.watch` stops delivering across a macOS sleep and fails
  silently — the mute dial learned this (`voiceRoom.watch` re-reads every 3s beside
  the watcher). The desk re-reads the directory on the same cadence and publishes only
  on change.

Test: a file with a dead pid is not on the roster; a live one is; an unparseable file
is skipped rather than thrown on (a corrupt announcement must not take the desk down).

## 2. The desk process and the proxy

`beth --desk` (or a `desk` bin beside it — same repo, same no-build rule, native
`.ts`). One listener bound to 127.0.0.1 on its own port (`HARNESS_DESK_PORT`, default
below the harness range so a new director never lands on it). It serves `ui/` and it
proxies.

**Routing.** `/d/<pid>/…` forwards to `127.0.0.1:<port>/…` for the roster entry with
that pid, over loopback. The forward is server-to-server, so it carries no `Origin`,
and the harness's CSRF guard (`src/origin.ts`) passes it as it passes `curl`. The bar
is keyed by REPO, not pid: a director restarted mid-session gets a new pid and the page
re-resolves the route from the roster, while the tab it lives in stays where it was.

- ⚠ **The desk is now the thing a tailnet page can CSRF.** `origin.ts` exists because
  `tailscale serve` makes "reachable" stop meaning "on this machine", and its whole
  argument moves to the desk: the desk applies `originAllowed` against ITS OWN `Host`
  on every write it forwards, and STRIPS `Origin` before forwarding, since a forwarded
  `Origin` would name the desk's host and the harness would refuse it against its own.
  Forgetting the first half re-opens the hole the guard closed on 2026-08-26;
  forgetting the second breaks every button on the page with a 403 that looks like the
  proxy failing.
- ⚠ **Two bodies must stream, not buffer:** `/api/stream` (SSE — a buffered stream
  is a page that never hears `hello`) and `/api/voice/say/` (audio — a buffered line
  is a voice that starts a sentence late). `/api/ear/audio` POSTs are small and
  frequent; forward them without waiting on anything.
- **A dead director** answers 502 through the proxy. The page's existing watchdogs
  reconnect, the roster poll drops the entry, and the bar greys the tab rather than
  removing it — a director that went down mid-conversation should look down, not gone.

**The page's one change.** `ui/app.js` fetches ~40 absolute `/api/…` paths and opens
`new EventSource('/api/stream')`. They go through one `api(path)` helper that prefixes
the selected director's route. ⚠ The same `ui/` is served by every plain harness, so
with no prefix in force the helper returns `/api/…` unchanged — a page that works only
under the desk is a page that broke every harness Danny has not restarted, the mirror
of the stale-tab gotcha in `CLAUDE.md`.

**Selecting a director** closes the current stream and opens the new one through the
new prefix. `hello` clears the transcript and the replay rebuilds it — the exact path a
reload takes today, so mirroring the conversation costs no new code. The composer,
the pointing chip, the mic and the plan panel all follow, because they all go through
`api()`. If switching ever feels slow, the next design is per-director transcript state
kept in memory with one stream each; it is not the first design because `app.js` is
one loom with shared state, and splitting that is the expensive change this plan
avoids.

⚠ **Between this step and step 4, the desk holds a stream to the SELECTED director
only.** A stream is a tab as far as a harness knows: the newest connection is the
elected speaker by default, and a page that is elected and drops `speak` on the floor
never reports playback done — which holds the talking stick until the backstop and
keeps every other beth quiet with no symptom on the page that caused it. So no
"watch" streams to the others until the page is ready to play what arrives on them.

## 3. The summons strip

Everything waiting on Danny, from every director, in one row of cards. The desk polls
each live harness's `/api/state` (decisions and workers are already there) on the
roster cadence and serves the pool as `/desk/summons`; the page renders a card per
item with the director's name on it and the candidate answers as buttons, because
that is what `queue_decision`'s `options` already are.

- **Answering here is answering there.** A button POSTs to that director's
  `/api/answer` through its prefix. Nothing new on the harness side.
- **A card selects its director.** Clicking the body of a card switches the bar to
  that director, so the context the question came from is on screen before the answer
  goes.
- ⚠ **Identity is a PAIR.** Decision ids are minted per harness; two directors can
  hold the same id. Key everything by (repo, id) — the plans panel learned that a
  reference is a pair rather than a string, and this is the same lesson.
- **Permission cards are not in `/api/state` today.** They ride the bus as `ask`
  messages from `askgate.ts` and pend forever by design. Exposing the pending asks
  as one more field on `/api/state` is the one small harness change this step needs,
  and it is worth it: a permission card on a director Danny is not looking at is
  exactly the silent hang `CLAUDE.md` describes, and the strip is where it becomes
  visible. Answering one goes through that director's `/api/permission`.
- **Counts on the bar.** Each director's tab carries its pending count, so the bar
  is a glance even when the strip is folded.

## 4. Voice — every director through one speaker

Speech never broadcasts: each harness sends `speak` only to its elected speaker
connection, and a page claims the election on focus (`/api/voice/claim`). So the desk
opens a stream to EVERY live director, claims speaker on all of them when it has
focus, and plays what arrives in each director's own voice — the room's talking stick
(`src/voiceRoom.ts`) already serialises them, so they take turns. Nothing is billed
that is not billed today; the room mute still gates upstream at each harness's bus
subscription.

- **The selected director's stream renders the transcript; the others feed only the
  strip and the mouth.** Their `speak` is played, their `pending` updates the strip
  (which can now stop polling those), and everything else on them is dropped.
- ⚠ **One playback queue, one report per line, routed home.** `ui/speaker.js` holds
  one queue and reports every ending (played, refused, errored, stopped) to
  `/api/voice/done`. With four sources, the report must go to the harness that spoke
  the line — through its prefix — and there must still be ONE queue on the page, not
  one per stream: the stick prevents overlap across harnesses in practice, but four
  `<audio>` elements in one tab is where an ending goes unreported. An unreported
  ending holds every other beth quiet with no symptom here.
- **The bar shows who is speaking.** A director Danny is not looking at can start a
  sentence; the tab lights while her line plays, so a voice has a face.
- **The mic goes to the selected director only.** `/api/ear/audio` and
  `/api/listening` (which ducks effort) route through the selected prefix. Switching
  directors mid-utterance abandons it (`Listener.abandon()` / the ear's abandon), never
  commits it — reaching for the bar is a way out of a sentence, the same rule as
  switching the mic off.
- **A director's own tab still wins on focus.** Focusing her desktop tab claims the
  election back from the desk; focusing the desk claims it for all. That is the
  existing rule, and it is the right one: the desk is one more tab as far as each
  harness knows.
- **The desk does not touch the mute.** Same universal mute, same volume slider, read
  from the same files. Danny works muted; the bell (`ui/bell.js`) still rings on the
  selected director's turn end and nowhere else.

## Out of scope, deliberately

- **The compact mode.** The current page on a phone is the real work — strip, panels,
  composer, one control at a time — and it is its own record. The desk lands on the
  desktop first; the only phone-shaped decision it makes is that Tailscale serve moves
  from one harness's port to the desk's.
- **Push.** A summons arriving while the page is closed is unsolved. Web push is the
  honest route and is an outbound registration rather than an inbound listener, but it
  is a new external dependency and is not taken without asking.
- **The assistant.** See above.

## Order, and why

1. **Roster** — a dozen lines in a harness, a reader with three tests. Everything
   else reads it.
2. **Desk and proxy** — the page under a prefix, one director at a time. This is the
   step that proves the `api()` helper degrades on a plain harness, and it is usable
   on its own: one tab instead of four.
3. **Summons strip** — the first thing the desk shows that no single tab could.
4. **Voice** — last, because it is the step where a wrong page is a silent one on
   every other harness, and the report routing wants the proxy to have been in use for
   a while first.

## What would flip this

- **Danny says the reading is the pain.** Then the assistant comes back, on top of
  this — she needs the roster, the proxy and the summons exactly as built.
- **Switching feels slow.** Then per-director transcript state, one stream each,
  rendered on select — the split of `app.js`'s shared state this plan avoided.
- **A director wants to know it is on a desk.** It should not. If a reason appears,
  re-read the project-agnostic paragraph in `CLAUDE.md` before adding a field.
