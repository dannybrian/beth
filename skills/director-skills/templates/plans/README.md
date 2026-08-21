# Plans

*Bootstrapped from the director-harness reference templates by `/director-skills`
(snapshot 2026-08-06). This repo owns this copy — edit freely.*

Plans are the canonical, repo-housed record of work. They live alongside the
code, get edited as understanding evolves, and outlast any individual session.
The [director harness](https://github.com/dannybrian/beth) reads this
directory to build its work panel; the `/plans` skill tracks which session is
doing what.

## Where plans live

Everything under `plans/`, most specific scope first. Two conventions the
tooling knows about:

- `plans/future/` — deferred ideas (the parking lot). Files there without
  explicit frontmatter surface as `parked` automatically.
- Subdirectories are fine (`plans/backend/`, `plans/ui/`) — the index walks the
  whole tree. If plans must live somewhere else entirely, add the tree to
  `PLAN_TREES` in `.claude/skills/plans/index.mjs` and point the harness at it
  with `HARNESS_PLAN_ROOTS`.

## Naming

- `YYYY-MM-DD-name.md` — date-prefixed, slugged. The date is the creation date.
- `YYYY-MM-DD-NN-name.md` — numbered series, when phase ordering matters.

## Frontmatter schema

Every plan carries YAML frontmatter:

```yaml
---
status: planning            # idea | planning | active | blocked | shipped | parked
name: null                  # optional spoken name — what the director calls it aloud
owner: null                 # session id, "human", or null when unclaimed
branch: main
started: null               # YYYY-MM-DD when status first → active
last_touched: 2026-08-06    # auto-updated by /plans tick
priority: P2                # P0 | P1 | P2 | null
tags: []
depends_on: []              # plan filenames; FIRST entry = parent when it names an umbrella
commits: []                 # short shas — derived by /plans, never hand-edited
commits_exclude: []         # shas whose trailer is wrong
commits_include: []         # shas that belong here but carry no trailer
---
```

### Status vocabulary (closed set)

| Status | Meaning |
|---|---|
| `idea` | Pre-design notion, no commitment yet |
| `planning` | Being designed, no code |
| `active` | Currently being implemented |
| `blocked` | Needs an unblock (note the reason in the body) |
| `awaiting-eyes` | Every mechanical gate passed; only a human read is owed |
| `shipped` | Implemented + merged |
| `parked` | Was active, now deferred |
| `review` | Assigned post-hoc by an audit; a human must reclassify |

Don't invent new statuses, don't use synonyms — the harness's reader parses
exactly this set, and an invented status renders as `unknown`.

## Authoring standard

Minimum body shape, so the index can excerpt consistently and an agent landing
cold can orient in 30 seconds.

**Required sections, in order, exact H2 headings:**

1. `## Context` — why this plan exists. Problem, motivation, intended outcome.
   The first paragraph becomes the plan's one-line summary in the index.
2. `## Approach` — the chosen direction and key decisions.
3. `## Verification` — how we know it works end-to-end. Commands, not vibes.

**Conventional optional sections** (use these names verbatim):
`## Files to Create / Modify`, `## Build Sequence`, `## Open Questions`,
`## Why this shape`, `## Risks`, `## Out of Scope`, `## Deferred`, `## Lessons`.

`## Lessons` is required for any plan executed by subagents: what broke past
the plan (with the fixing commit), `CORRECTION:` entries when an earlier
conclusion turns out wrong, and where each lesson landed durably — a lesson
whose only home is a commit message is not landed.

**Length + tone:** scannable over exhaustive. ~150–500 lines for a feature,
~30–80 for a fix. Concrete file paths, not "the config file". Task checkboxes
(`- [ ]`) are what the harness's progress bars count — a plan with none shows
"no tasks", which is honest, not zero percent.

## The `/plans` skill

`.claude/skills/plans/` — claims, status changes, the board, scaffolding, and
the derived `plans/INDEX.md`. See its SKILL.md for commands. Plans are the
source of truth; the skill writes frontmatter and session records, and
everything else is derived from those.

## The role-lock plan

One plan is not a deliverable: the plan the director harness watches to decide
whether a terminal session already holds the director role
(`HARNESS_DIRECTOR_PLAN`). Claiming it IS holding the role. It stays `active`
forever and is excluded from the harness's live board.
