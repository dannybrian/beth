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

## Open questions

- **Reference format.** What exactly lands in the chat input on click — a path, a title,
  a `[title](path)` pair? It has to read well aloud and resolve unambiguously.
- **Claude Code handoff mechanism.** CLI with a seeded prompt, or a URL scheme? Verify
  before designing.
- **Umbrella plans.** Danny mentioned these; the plans system has `depends_on` but no
  parent/child. Does the panel infer hierarchy, or does the plans format gain it?
- **Search scope.** Titles and frontmatter only, or full body text? Full text is more
  useful and invites "just ask Beth" instead — which may be the better answer.
