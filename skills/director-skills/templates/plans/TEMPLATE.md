---
status: planning
owner: null
branch: main
worktree: null
started: null
last_touched: TODAY
priority: P2
tags: []
depends_on: []
---

# <Plan Title>

## Context

<Why this plan exists. What problem it solves. What prompted it. The intended outcome.>

## Approach

<The chosen direction. Architecture decisions. The "what we're going to do." Recommended only — alternatives belong in `## Why this shape` if they're worth recording.>

## Files to Create / Modify

**Create:**
- `path/to/new-file.ts` — purpose

**Modify:**
- `path/to/existing.ts` — what changes

**Reuse:**
- `path/to/utility.ts` — existing helper to lean on instead of reinventing

## Build Sequence

### Phase 1 — <name>
1. step
2. step

**Verification:** how to confirm this phase landed.

### Phase 2 — <name>
1. step

**Verification:** how to confirm.

## Verification

<End-to-end test plan once all phases ship. Concrete commands. URLs. MCP tools to invoke.

If this repo has a standing testing contract (a TESTING.md, a validation skill), name it
here and fold its gates into the Build Sequence as TASKS — a gate that lives only in
prose is a gate nobody runs. Verification pending ⇒ plan stays `active`, or
`awaiting-eyes` when only a human read is owed.>

## Open Questions

- <unresolved decision to make during execution>

## Lessons

<Filled in at ship time — required if subagents executed this plan. What broke past the
plan (one line + fixing commit each); CORRECTION: entries for conclusions that turned out
wrong; where each lesson landed durably (doc/test/skill). See the authoring standard in
plans/README.md.>
