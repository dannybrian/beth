---
name: plans
description: Track which plans are actively being worked on across multiple Claude Code sessions in this repo. Invoke when the user starts work on a plan ("let's work on X", "starting X" → claim), gets blocked ("blocked on Y" → status blocked), ships a plan ("shipped Z", "done with Z", "merged Z" → status shipped + release), or asks orientation questions ("what's running", "what am I working on", "where am I", "what's the status of <plan>"). Also for scaffolding new plans ("new plan for X", "scaffold a plan") and regenerating the index. Each Mac Terminal tab is a session keyed by $TERM_SESSION_ID.
argument-hint: [command] [args]
allowed-tools: Bash
---

# /plans — Multi-Agent Work Tracker

*Vendored from beadgame's reference implementation by `/director-skills` (snapshot 2026-08-06). This repo owns this copy — edit freely.*

Track which plans are in flight across multiple Claude Code sessions. Plans are the canonical asset; this skill maintains a session ledger and a derived index.

## When to invoke

**Auto-invoke when:**
- The user says "let's start work on plan X" or "I'm working on Y" → `claim`
- The user says "blocked on" or "I need to wait for" → `status blocked`
- The user says "shipped" / "done" / "merged" a plan → `status shipped` then `release`
- The user asks "what's running", "what am I working on", "where am I" → `where` (if claimed) or board (if not)
- The user asks "what's the status of <plan>" → `index` then point them at `plans/INDEX.md`
- The user asks "what shipped for <plan>" / "what landed under X" → `commits <plan-path>`
- After completing a meaningful unit of work on a claimed plan → `tick`

**Don't invoke when:**
- The user is mid-task and just answering a routine question
- The work is a one-off chore that doesn't warrant a plan

## Commands

Run via Bash: `node .claude/skills/plans/index.mjs <command> [args]` (works from any subdirectory — the CLI walks up to the repo root).

| Command | Purpose |
|---|---|
| `(no args)` | Print status board: active sessions first, then blocked, then planning |
| `new <slug> [--scope <path>] [--series]` | Scaffold a new plan from `plans/TEMPLATE.md`. `--scope` picks tree (default `plans`). `--series` prefixes the next plan number within that scope (per-scope counter; gaps OK). |
| `claim <plan-path> [--force]` | Mark this terminal as the active claimant on `<plan-path>`. Updates frontmatter `owner` + `last_touched`. Refuses a plan held by another live (non-stale) session — unless that owner's own session record now names a *different* plan (see below) — unless `--force` is passed, which takes it anyway and warns which session is being displaced. |
| `tick [--quiet]` | Heartbeat current session + bump `last_touched` on the claimed plan, but only if we still own it. `--quiet` is silent + no-op when no claim (used by the Stop hook); staying quiet also covers the lost-ownership case since the hook must never get noisy. |
| `status <state> [--force]` | Set frontmatter `status` on the claimed plan, refusing loudly if we no longer own it. State must be one of: `idea`, `planning`, `active`, `awaiting-eyes`, `blocked`, `shipped`, `parked`, `review` — the same closed set `plans/README.md` documents. |
| `release [--force]` | Drop the claim. Doesn't change status. |
| `index [--prune]` | Regenerate `plans/INDEX.md` + `plans/INDEX.json`. With `--prune`, also clear stale claims first. |
| `where` | Re-orient: print current claim, plan summary, last 3 commits |
| `graph` | ASCII dependency tree of plans with `depends_on` declared |
| `prune [--dry-run]` | Clear session records older than 4h heartbeat |
| `resume [<plan>]` | Print `claude --resume <id>` commands for active claims (or just one). Captures `$CLAUDE_CODE_SESSION_ID` at claim time so you can re-enter a conversation in a fresh tab. |
| `commits [<plan>] [--sync]` | Show commits whose body has a `Plan: <path>` trailer (oldest first), plus anything the plan claims via `commits_include:`, minus anything it disowns via `commits_exclude:`. With `--sync`, write the short-sha list to the plan's `commits:` frontmatter. |
| `commits suggest [<plan>]` | Backfill helper: print candidate commits for plans without trailers (matched on plan filename slug). Read-only — paste accepted shas into **`commits_include:`**, never into `commits:`. `commits:` is rebuilt WHOLESALE from git trailers on every sync, so a sha hand-written there survives only until the next sync of that plan and then vanishes silently. `commits_include:` exists for exactly this case: a commit that honestly belongs to the plan but carries no usable trailer. |

**Filters (apply to `board` and `graph`):**

| Flag | Effect |
|---|---|
| `--tag <name>` | Only plans tagged `<name>` |
| `--status <state>` | Only plans with that status |
| `--scope <path>` | Only plans under that path prefix (e.g. `plans/backend`) |
| `--all` | Board only — include shipped, parked, idea |

## Auto-heartbeat (optional)

If the repo wires a `Stop` hook to run `tick --quiet` after every Claude turn, the claimed plan's `last_touched` stays current automatically. No hook is installed by the bootstrap — without one, call `tick` yourself at natural pauses. Everything degrades gracefully; a stale heartbeat shows as `stale`, nothing breaks.

## Auto INDEX regen

`claim`, `status`, and `release` each run a *light* `index` regen as a side effect (skips the per-plan `git log` sync since lifecycle ops don't change commit linkage). ~250ms each. Anything watching the plan files — the director harness's panel watches them directly — sees ownership/status changes without anyone running `/plans index` manually.

## Commit linkage (optional)

The trailer machinery below is designed for git hooks the bootstrap does **not** install — it is the part to wire up only once the basics have earned their keep. The frontmatter keys work regardless; only the automatic stamping needs hooks.

A `prepare-commit-msg` git hook, when installed, appends a `Plan: <plan-path>` trailer to every commit message when the current terminal has an active claim. It should stay silent on no-claim, amend, merge, and squash — never block.

It also stays silent when the claim can't be trusted to be ours (`fallback-` session id, or a heartbeat older than 4h) and when `PLANS_NO_TRAILER=1` is set — `PLANS_NO_TRAILER=1 git commit …` is how a terminal holding a claim commits something unrelated without the release/re-claim dance. A trailer that lands wrongly is repaired on the plan side with `commits_exclude:`; a commit that honestly belongs to a plan but carries no usable trailer at all (predates the hook, or was stamped for a different plan) is claimed with `commits_include:` — same sync funnel, opposite direction, exclude wins if a sha is in both.

A companion `post-commit` hook (chaining any hook already present) runs `node .claude/skills/plans/index.mjs post-commit` in the background. That subcommand reads HEAD's commit message, extracts every `Plan:` trailer, syncs the referenced plan(s)' `commits:` frontmatter, and re-renders INDEX. ~400ms, doesn't block git.

With both hooks in place, the `commits:` field on every plan stays in sync with what's actually in main.

## Parked inference

Plans under any `future/` segment without explicit frontmatter are surfaced as `parked` (instead of `unknown`). Inferred at `summarize()` time — never written back to the plan file. Files with explicit `status:` frontmatter are unaffected. This covers historical parking-lot ideas; new ones get explicit `status: parked` from the `/park` skill.

## Session identity

`.claude/skills/plans/lib/session.mjs` picks the most specific id available
(`TERM_SESSION_ID` → `ITERM_SESSION_ID` → `CLAUDE_SESSION_ID`/`CLAUDE_CODE_SESSION_ID` → a
`fallback-` hash), and session records live at `.claude/sessions/<session-id>.json`, gitignored. A
`fallback-` id is shared by every session in one directory, so `claim`, `status` and `release` refuse
to run under one without `--force`.

Beside the `--force` note: `claim` also allows a plan whose owner's own record has moved on to a
*different* plan — the workflow one section up (claim a second plan without releasing the first)
leaves exactly that dangling `owner:` behind, and refusing it would lock a plan nobody holds. `status`
and `tick` check current ownership before writing, for the same reason `--force` needs care — a
displaced session is never told, so it must not keep mutating a plan it no longer owns.

## Stale claims

A claim with no heartbeat in 4h shows as `stale` in the board but isn't auto-cleared. Use `release` to drop, or just claim a new plan in the same terminal.

## Testing

`node --test '.claude/skills/plans/**/*.test.mjs'`. Wire it into whatever gate the repo already runs; run it by hand after editing anything under `.claude/skills/plans/`.

## Notes

- Plans are the source of truth. The skill writes frontmatter + sessions; everything else is derived.
- See `plans/README.md` for the frontmatter schema and authoring standard.
- The skill works from any subdirectory in the repo — it walks up to find the repo root (`CLAUDE.md` **and** `.git` at the same level; a checkout missing either falls back to resolving relative to the script, which assumes the standard `.claude/skills/plans/` location).
