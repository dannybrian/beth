---
name: tidyrepo
description: Triage and commit lingering uncommitted/untracked files across the repo — attribute each to the work that owns it, ask the user about anything non-obvious, then commit surgically in well-scoped groups. Use when the user wants to "get clean", clean up the working tree, sweep stragglers before a release, or asks "what's all this uncommitted stuff". NOT for committing the current session's own in-flight work.
argument-hint: [optional scope path]
allowed-tools: Bash, Read, Grep, Glob, AskUserQuestion
---

# /tidyrepo — Working-Tree Triage & Surgical Commit

*Bootstrapped from the director-harness reference templates by `/director-skills`
(snapshot 2026-08-06). This repo owns this copy — the § Project-specific rules
section is yours to grow.*

Multiple concurrent sessions commit to main, and stragglers accumulate:
plan-frontmatter churn from the `/plans` Stop hook, untracked plan files,
generated reports, editor droppings. This skill turns that pile into clean,
attributed commits — or flags it for the user.

## Hard rules (non-negotiable)

1. **Never `git add -A` or `git add .`** — stage every file by explicit path.
2. **Never delete a file without the user's explicit confirmation in this
   conversation.** Gitignored/untracked ≠ deletable. Never `git clean`.
3. **Path-limited commits still sweep the file's WHOLE working-tree diff.**
   Before committing any file, read its full diff. If a file plausibly contains
   another live session's WIP, don't commit it — flag it.
4. **Respect live claims.** Files that belong to a plan currently claimed by
   another session (check `plans/INDEX.md` owners) are that session's WIP.
   Leave them and say which session owns them.
5. **Never revert/checkout a modified file to "clean" it** without
   confirmation — that's data destruction, same as deleting.

## Procedure

### 1. Survey

```bash
git status --porcelain=v1
```

Bucket every entry: modified plans / INDEX files, modified source, deleted
files, untracked files. If `$ARGUMENTS` gives a scope path, limit to it.

### 2. Attribute — build an evidence table

For each file (or coherent group), gather evidence before deciding:

- **`git diff <path>`** — what actually changed. Never commit a diff you
  haven't read.
- **`git log --oneline -5 -- <path>`** — who touched it last, under what topic.
- **Plan frontmatter churn** (`status`/`owner`/`last_touched`/`commits` lines
  only) is `/plans` machinery output → safe housekeeping commit, grouped with
  the INDEX regen.
- **Untracked plan files** with real frontmatter → commit to the plans dir.
- **Generated/report files** at odd locations → ask the user: commit,
  relocate, or delete.
- **Large new binaries**: check how the repo handles them (LFS? ignored?)
  before committing anything multi-MB raw.

### 3. Ask — one batched question round

Collect everything non-obvious into a single `AskUserQuestion` round (max 4
questions; run a second round if needed). Give per-file recommendations. Don't
ask about things the evidence already settles.

### 4. Commit — surgical groups

- Group by topic/owner, not by directory: one commit per coherent story.
- Stage explicitly: `git add <path> <path> …`. For a file with mixed hunks
  (ours + someone else's), stage only the wanted hunks via `git apply --cached`.
- Messages follow the repo's commit style; mention the owning plan in the body
  when known. If this session holds a `/plans` claim, remember any
  commit-trailer hook will stamp that plan — release first if these cleanup
  commits aren't that plan's work.

### 5. Report

End with: commits made (sha + subject), files intentionally left (and which
session/plan owns them), files awaiting a user decision, and whether
`git status` is now clean.

## Project-specific rules

<!-- Grow this section as the repo teaches you its sharp edges: asset formats
     that dirty themselves, directories that must never be committed raw,
     generated files that look hand-written. The reference implementation's
     version of this section is mostly Unity scar tissue — yours will be
     something else. -->

- (none yet)
