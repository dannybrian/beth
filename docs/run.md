# The run button — start and stop the project's app

> Danny, 2026-10-27: *"I have an increasing number of projects where I want to start
> up and stop the app from the harness … a button to run, pegging the url (if any) at
> the top, and changing to a stop button to terminate it."*

AGREED and BUILT 2026-10-27 (`src/appRunner.ts`, her `run` tool, the strip's ▶/■
with a ▾ panel). Verified on a throwaway `node --watch` app: ▶ learned the url from
the output, Keep made it a declaration, the harness was stopped with the app up and
a fresh one found it running, and one ■ took npm, the watcher and the server down
together. Her tool started it from a spoken-style request. Step 5 — declaring the
three repos — is still Danny's. The rest of this record is the design as agreed.

The projects it is for are appresent2, elvidrio and
talktree: web apps he opens SPORADICALLY to look at something, then leaves. Tulito
prompted the idea, through its `launch` build hack, but it is the poor fit: it is a
desktop app that has to be asked to quit so a dirty document gets its prompt. See Set
aside.

## What this is, and what it is not

It is a third runner beside the test and build lights. ▶ starts the project's app, the
button becomes ■, and the app's URL goes on the workbench while it is up. ■ stops it
and the URL comes down.

It is not the build button stretched. `buildRunner` is fire-and-report: it runs
something that ENDS, kills the process group when it does, and reports a light.
Pointing it at a server is a yellow light that never settles, and getting a process to
survive it took tulito a fork/`setsid`/close-on-exec-pipe dance whose first version
killed the app before it was born (see that repo's `scripts/build.sh launch`). The
build's refusal of `dev`/`start` stays. Those scripts belong to this runner.

## The URL is the record, and the port is the truth

A harness restarts several times a day, and the app may have been started without it:
from a terminal, or by a worker. Right now talktree's harness is listening on 4317 and
no beth started it. A pid the harness remembered can know none of this, so the harness
remembers nothing. The PROJECT declares where its app lives, and whether it is up is
read off the port each time:

```
HARNESS_RUN_CMD   argv, split on whitespace like the build's; default: detected
HARNESS_RUN_URL   where the app is; its host:port is what gets probed
```

Both use the existing layers: the repo's `.env`, or the gear panel, which wins as it
does for the build command. That declaration in the project is the run record: with
it, ▶/■ is correct after a restart and correct for an app the harness never started.

- **Status** is a TCP connect to the URL's port on loopback. It is cheap enough to poll
  every few seconds while a page is open, and it is checked again after every press.
- **Ownership** is checked before anything is signalled. A listener on that port
  counts as THIS project's only if its working directory is inside the repo
  (`lsof -a -p <pid> -d cwd`). The same rule as `/api/image`: act only on what you can
  prove. Something else on the port shows as "port 5178 is taken by `<command>`", and
  ▶ refuses rather than starting a copy that dies with EADDRINUSE.
- **Stop** signals the listener's PROCESS GROUP, SIGTERM then SIGKILL, reusing
  `runCommand`'s escalation. ⚠ The group, not the pid: elvidrio's `dev` is
  `node --watch …`, and the listener is the CHILD. Kill only the child and the watcher
  parent lives on, holding nothing and restarting it on the next save. The group is
  proven before it is signalled: its leader's cwd must also be inside the repo.

### Detection, when nothing is declared

Root `package.json` → `dev`, then `start`. That covers appresent2 (`dev`, port 5180)
and elvidrio (`dev` → `app/`, port 5178). Talktree has no root `dev` (its server is in
`packages/harness`), so it declares one: `HARNESS_RUN_CMD=pnpm -C packages/harness dev`.

With no declared URL, the run reads it from the app's own output: the first
`http://localhost:N` or `http://127.0.0.1:N` it prints. All three print one in their
startup banner, and appresent2's first is the display, not the iPad controller, which is
the right one. A URL learned this way covers only that run. The panel offers to keep it
(a gear setting), because without a declared URL there is nothing to probe after a
restart, and the button would claim "stopped" while the app is up.
⚠ The detector must be tested against the REAL banners of these three apps, pasted.
An invented one is how the node `--test` fixture went green while wrong.

## A start the harness makes

The app runs in its own session (`detached: true`), so a `/restart` does NOT take it
down. After the restart, the probe finds it again like any other running app. Its
output goes to `<stateDir>/run.log`, truncated at each start. That log is the one thing
the harness keeps, and it is for reading, not for knowing state. An app started
elsewhere has no log here, and the panel says so ("started outside the harness — no
output here") rather than showing an empty pane.

↻ (restart) sits beside ■: stop, wait for the port to free, start. After a fix, that is
the common act, and stop-then-start is two clicks for one act.

An exit nobody asked for turns the light red and keeps the log tail. That is the
moment the panel's paste button (the build panel's, reused) earns its place: hand her
the crash.

## The workbench

Running puts the URL on the bench. Stopping takes it off, because a dead link in the
boldest spot on the page is the same lie the build light's stale yellow exists to
prevent. But the bench holds ONE URL, and he may have pinned a PR there, so it gets a
`source` (`'run' | 'pinned'`):

- A run sets the bench only when it is empty or its source is `'run'`. A pin is never
  overwritten by a run.
- A stop or a crash clears it only when its source is still `'run'`.
- When the bench holds a pin, the URL rides on the run button's tooltip instead, so it
  is still one click away.

## Hers too

A `run` tool: `start | stop | restart | status | log`. "Restart the app now the fix is
in" is said out loud, and the voice version of a button has to be a tool. `log` returns
the tail, capped like the wire's previews. She already runs shells, so this grants
nothing new. What it adds is the same ownership proof and group stop the button uses,
instead of a `pkill` she improvises.

## The page↔server contract

`hello` carries `run: true`. A page reloaded against a harness that predates it shows
no button, so a NEW page on an OLD server degrades rather than drawing a control that
404s. The state rides the bus as a current-state message beside `tests` and `build`
(sent on connect, kept out of the replay), shaped `{ state, url, owned, why, exit? }`,
where `owned` says whether this harness started it and so has a log.

## Steps

1. **`src/appRunner.ts`.** Detection, URL vetting (`vetBenchUrl`, plus a port) and
   the banner sniff, the probe, the cwd proof, a detached start with the log, and a
   group stop. Tests where a mistake is invisible:
   - the sniff, against the three real banners;
   - a REAL `node --watch` tree stopped with nothing left behind (the `runCommand`
     test pattern);
   - a listener whose cwd is outside the repo refused, never signalled;
   - a restart, simulated by a fresh runner over a live app, reading it as running.
2. **The strip button and panel.** ▶/■/↻, the log tail with the paste button, the
   `hello` flag.
3. **Bench `source`.** The two clearing rules, with the existing `workbench` tests
   extended.
4. **Her `run` tool.**
5. **The three repos.** Talktree needs `HARNESS_RUN_CMD`. Each gets `HARNESS_RUN_URL`
   in its `.env`, which is Danny's file, so it is his edit or done with his yes.
   Verified by starting, stopping and restarting each one from its own beth.

## Set aside

- **Tulito, and non-web apps generally.** A desktop app has no port to probe, and its
  stop must be a polite request, not a signal. The shape for it was agreed in the same
  conversation: a project run SCRIPT with `start` / `status` (init-script exits:
  0 running, 3 stopped, optional `url=`/`log=` lines) / `stop` verbs. Tulito's script
  already has the pieces (`pgrep` on the apphost, `quit-request`). Build it when a
  second non-web project wants it. Tulito alone does not pay for the extra contract.
- **Reaching the app from the iPad.** The bench links to `127.0.0.1:5178`, which on the
  iPad is the iPad. Beth itself reaches the iPad through a `tailscale serve` mapping
  per port. Each app would need its own mapping, and then the bench would show a
  different URL from the one probed. That needs a decision of its own; do not invent
  one here.
- **More than one app per repo.** It turns "is it up?" into a list, the same reason
  the bench holds one URL.
- **Auto-start on boot, and auto-stop when idle.** Starting project code without a
  press needs the test monitor's per-repo enable (`buildRunner.ts` warns about
  exactly this). Idle stop needs a definition of idle that a sporadic user would
  agree with.
- **A "running old code" yellow.** These apps hot-reload or `--watch`, so it would be
  wrong for all three.

## What would flip this

- **Talktree's runner binds port 0 (any free port).** Then the declared port is a
  guess, and status has to come from a script instead. That would be the trigger to
  build the script contract above for web apps too.
- **A second desktop app.** Same trigger, from the other side.
