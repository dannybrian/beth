# Plans panel — the harness as the project surface

> Danny, 2026-08-01: *"a panel showing in-progress plans… I could click one to open the
> plan file… links in the harness to open things in repo too, even if it's with VSCode, or
> better yet — Claude Code, letting me hand off things quickly. It would let me click a
> task or a plan to copy its reference to the chat input for Beth."*

This is the "Visualization" bullet from the original harness brief — *see WHERE work is
being done, track progress-to-completion* — finally landing on a concrete shape.

## What this actually is

Not a plans viewer with a chat bolted on. Three distinct capabilities, and they are
worth separating because they have different costs and different payoffs.

### 1. Deixis — the important one

**Clicking a plan or task to drop its reference into the chat input gives Beth the
ability to point.** "This one." "That task." It is how people actually talk about work,
and it is the single hardest problem in a voice interface: you cannot say
`plans/2026-08-01-director-context-diet.md` out loud, and you should never have to.

Everything else on this page is a nice panel. This is the unlock. It should be designed
first and everything else arranged around it.

Implication: a reference needs a *spoken* form as well as a machine form. Clicking
should insert something Beth can read back naturally ("the context diet plan") while
carrying the path underneath. A reference is a pair, not a string.

### 2. Handoff — open it where the work happens

Three targets, ascending in value:

- **GitHub link** — trivial, works from anywhere, read-only.
- **VSCode** — `vscode://file/<abs-path>:<line>` opens locally. Well-defined scheme.
- **Claude Code** — the one Danny actually wants. The harness runs locally with shell
  access, so it can spawn a terminal running `claude` seeded with a prompt about that
  plan. This turns the panel into a dispatch surface: read a plan, decide it needs real
  work, hand it to a fresh implementer session in one click.

The Claude Code handoff is the highest-value and least-specified. Verify what is
actually available (CLI invocation with an initial prompt vs. a URL scheme) before
designing the UI around it.

⚠️ It also collides with existing discipline: **one implementer at a time**, and
`/plans` claims. A one-click handoff that silently starts a second implementer on a
claimed plan would be a regression. The button must respect the claim state — and
probably refuse, loudly, rather than warn.

### 3. Tasks — and the plans-format question this forces

The original harness plan flagged "plans-system evolution (unknown shape)" as an open
question. **This is the shape.** Showing "tasks completed and pending" requires plans to
have tasks, and today plan bodies are prose (`## Context` → `## Approach` →
`## Verification`).

Recommended: **markdown checkboxes** (`- [ ]` / `- [x]`) inside the existing body.
Reasons — lightweight, human-editable, git-diffable, no schema migration, degrade
gracefully in every other tool, and both a terminal Claude session and Beth can tick
them as work lands. A structured task list in frontmatter would be tidier to parse and
much worse to live with.

Cost: it is a convention change across the plans corpus, and only new/touched plans
would have it at first. The panel must render a plan with no checkboxes as simply
"no tasks", never as "0% complete".

## Architecture

The harness server watches `plans/**/*.md` and keeps an in-memory index: frontmatter,
task counts, claim/owner state, and body text for search. File watching beats polling
here — the dashboard's Plans tab polls `INDEX.json` every 30s; the harness can be
current within milliseconds because it is already a long-lived local process next to the
files.

**One index, two consumers.** The panel reads it over the existing stream; Beth reads it
through a tool, the same way `pending` already works. That symmetry matters: when Danny
asks "what's in flight?" out loud and when he glances at the panel, the answer must come
from the same place, or they will disagree and he will stop trusting both.

### ⚠️ This is where the adapter interface stops being theoretical

We just split role (harness) from person (`<repo>/.claude/DIRECTOR.md`). A plans panel
that hard-codes beadgame's `/plans` conventions would undo that.

The seam: the **harness defines a shape** — a work item with id, title, status, owner,
tasks, links, and a spoken name — and a **reader** produces it from whatever the project
actually stores.

**Correction to the obvious design (2026-08-01):** the instinct is "the repo supplies the
reader", by analogy with `DIRECTOR.md`. That is wrong for this case. `/plans` is *Danny's
convention*, not beadgame's private format — it is likely to be the shape in every repo
he runs a director against. So:

- **`/plans` is a BUILT-IN adapter in the harness**, one reader among N. beadgame ships
  nothing and changes nothing; it just keeps having plans.
- **Repo-supplied readers are the escape hatch**, for a project whose work lives
  somewhere foreign (GitHub issues, Linear, a bespoke tracker).

This keeps the harness honest — it still never assumes a single format — while not
inventing a plugin ceremony for the format we will use 95% of the time.

Building this feature *is* Phase 4.

## Where to build it

Almost all of it is harness-side: the watcher, the index, the panel, the tool, and the
`/plans` reader all live in this repo. beadgame contributes only its existing plans.

So: **build it from a fresh session in `director-harness`**, with this document as the
handoff. Give that session read access to a real corpus — `--add-dir ~/Sources/beadgame`
— because the reader must be written against real frontmatter and real `INDEX.json`,
not against an idea of them. Test by running `beth` from beadgame as usual; the harness
binds there while the code being edited lives here.

The long design session that produced this document is in beadgame's history
(`plans/future/2026-07-31-director-conversational-harness.md`, ~17 commits). That record
stays where it was made. Forward work belongs here.

## Relationship to the dashboard Plans tab

This largely supersedes it **at the desk**, and that qualifier matters: the dashboard is
reachable from anywhere and survives the harness not running; the harness is local, and
deliberately so. Do not delete the dashboard view on the strength of this. Let it decay
naturally if it goes unused.

## What was built (2026-07-31)

Deixis, the index, the panel and the tool. Handoff and search are not built; the seams
for them are noted below. Code: `workItems.ts` (the shape and the reader seam),
`plansReader.ts` (the built-in `/plans` reader), `spokenName.ts` (naming, tested),
`workIndex.ts` (index, watcher, reference resolution).

**A reference is a pair, and neither half lives in the text.** The composer holds chips,
not a `[title](path)` string: the chip shows the spoken name, the path rides underneath,
and the turn posts `{text, refs[]}`. The server composes what Beth receives — a preamble
naming what was pointed at and instructing her to use the spoken name — while the
transcript shows what Danny typed. Keeping the two apart means he can edit his sentence
freely without dangling a reference, and a turn can be pure gesture (click, send).

`WorkIndex.preamble(refs)` is the single place that phrasing lives. What it hands Beth is
the *pair*: the path (so she can resolve and open it) with status and task counts inline,
plus the spoken name and an instruction to use that name aloud and never the path.

**Pointing lives on the server, so voice works too.** Holding the chips only in the page
meant clicking a plan and then SPEAKING lost the reference — a spoken turn never passes
through the browser, since ElevenLabs dials the harness directly and the utterance goes
straight to the director. So the page mirrors its chips to `/api/point`, and both input
paths converge on `SessionManager.sendPointed()`, which CONSUMES them: a reference is
spent by the turn that uses it, exactly as the composer chips clear on send. Consumption
is broadcast so the page drops chips a spoken turn just used.

Deliberately not folded into `send()` — a resolved decision or the promote nudge are turns
too, and must not silently eat a reference held for the next question.

⚠️ The page mirrors chips and posts the turn as two separate fetches, which are not
guaranteed to arrive in order. A late-arriving mirror re-armed a reference the turn had
just consumed, stapling it to the *next* spoken turn. Updates carry a sequence number and
stale ones lose — and the comparison must be `<=`, not `<`: a spoken turn consumes without
supplying a seq of its own, so the duplicate arrives carrying the same number as the
update already applied. `<` waved it straight through. Caught in a live run, not in the
first test written for it.

**Spoken names are derived, and that turned out to be the substance.** Measured against
the real corpus: cutting a title at its em-dash reads well but collapses 69 plans into
collisions — three in-flight plans all become "Viz sidecar", others become bare "Design".
So naming is a candidate ladder (headline → filename → full title → qualified) with
collision resolution across the whole index; the filename is often the best name because
Danny chose it. Result on beadgame: 571 plans, zero duplicates.

**Plans can name themselves.** `name:` in frontmatter wins over any derived name,
verbatim. Nothing uses it today, which is why derivation has to be good on its own.

**One index, two consumers — and it needed enforcing.** First live test: asked what was
left on a plan, Beth *grepped the file* rather than calling the tool. Her regex would
have counted checkboxes inside code fences and missed indented ones — a different number
than the panel, which is the exact failure this design is meant to prevent. The tool
description and persona now say so explicitly. Verified: she calls `plans` and speaks
names, not paths.

### Reader notes, from the real corpus

- Plans are **not** in one directory — 571 across a dozen roots, most under `game/plans/`,
  not the top-level `plans/`. `plans/**/*.md` would have missed the bulk of them.
- The **title is not in frontmatter**; it is the first H1.
- **Checkboxes inside fenced code blocks are samples, not tasks.**
- `future/` without explicit status means **parked** — mirroring the `/plans` skill, or
  dozens of parking-lot ideas surface as `unknown` straight into the panel.
- A stale `owner:` is **not** a live claim. Liveness needs a fresh session record naming
  that plan. This is the check the handoff must refuse on.

### The harness reads; it does not own

The project's `/plans` and `/tidyrepo` own where plans live and whether they are accurate.
The reader never writes a plan file, never repairs frontmatter, never re-homes anything.
Discovery defers to the project's own index for *where* to look and reads the files
themselves for *what is true* — so the panel is fresh without becoming a second authority.

## Open questions

- ~~**Reference format.**~~ Resolved: a chip carrying `{spoken, path}`, never a string in
  the input. See above.
- ~~**File links in chat.**~~ Built 2026-07-31. Detection is server-side and
  high-precision: a candidate becomes a link only if it is a path in the index or a file
  that provably exists in the repo (`links.ts`), so nothing is guessed. Beth emits no
  markup at all — which matters because she is heard, and markdown in her prose would
  either be spoken as punctuation or need another stripping pass. Click opens VSCode;
  ⌘-click on a plan points her at it instead, reusing the reference chips.
- ~~**Claude Code handoff mechanism.**~~ Verified: it is the **CLI with a seeded
  prompt** — `claude [prompt]` takes a positional prompt, plus `--add-dir`, `-r/--resume`
  and `--permission-mode`. No URL scheme needed. Deliberately NOT `--bg`: the point is to
  take something over interactively, and a background agent is a second implementer with
  nobody watching.
  Still to build. The index already carries `claim.live` (re-check at click time, the way
  `canPromote` does) and per-task `line`. Refuse on a live claim, naming the holder; allow
  on a stale owner while saying so. The harness must not claim the plan itself — it seeds
  Claude Code with a prompt telling *it* to run `/plans claim`, keeping `/plans` the only
  writer.
  Safe to build now only because the API is loopback-only; an endpoint that spawns a shell
  on a tunnelled server would have been remote code execution.
- **Umbrella plans.** Still open, and now has a lever: `name:` lets an umbrella plan take
  a name reflecting what hangs off it. Danny also wants naming from the **UI** — renaming
  a plan without editing its file. `WorkIndex.nameOverrides` is that seam: consulted
  before frontmatter, empty today. Landing it is populating the map plus an affordance,
  not a refactor. Hierarchy itself is still unmodelled.
- **Search scope.** Unbuilt. `/api/work?scope=all` exposes the whole index, and bodies are
  deliberately not held in memory yet — 571 plans of body text is the cost to weigh when
  full-text search is actually wanted.
