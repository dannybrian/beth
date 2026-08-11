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

Standing requirements (contract in `game/docs/TESTING.md`):
- Renderable work: name the on-screen gates as TASKS in the Build Sequence — a mid-plan
  smoke after the first renderable task, and a pre-ship visual read of the spec's
  on-screen checklist. Visual read pending ⇒ plan stays `active`.
- Cross-stack work: the server-assumption test plan (unit + integration) is a separate,
  earlier plan this one lists in `depends_on`.>

## Open Questions

- <unresolved decision to make during execution>

## Lessons

<Filled in at ship time — required if subagents executed this plan. What broke past the
plan (one line + fixing commit each); CORRECTION: entries for conclusions that turned out
wrong; where each lesson landed durably (doc/test/skill). See plans/README.md § Lessons.>
