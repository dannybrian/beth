---
status: active
name: the director role
owner: null
branch: main
started: DATE
last_touched: DATE
priority: null
tags: [director]
depends_on: []
---

# Director role lock

*Bootstrapped by `/director-skills` (snapshot 2026-08-06).*

## Context

This plan is the DIRECTOR ROLE LOCK, not a deliverable. The
[director harness](https://github.com/dannybrian/beth) reads this
file's claim state to decide whether a terminal session already holds the
director role: a live `owner:` here means a terminal director is running, and
the harness comes up as a shadow — read everything, claim nothing.

The role is held by claiming a plan because `/plans claim` is the claim
mechanism this repo already has, and session records key on a plan path — so
the lock has to be a file `/plans` can write an `owner:` into. That makes it a
plan by construction while being a standing ledger by nature.

## Approach

Point `HARNESS_DIRECTOR_PLAN` at this file's path in the repo's `.env`. A
terminal session that wants the role runs `/plans claim` on it; the harness
never claims it with `--force` and neither should you.

## Verification

Permanently `active`, no tasks, no completion condition. If this plan shows up
on a work board, the board's reader is not excluding the role lock.
