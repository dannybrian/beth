---
name: director-skills
description: Set a repo up for the director harness — or diagnose why the harness's work panel is empty. Invoke when the user wants to onboard a repo ("set up the director here", "bootstrap plans"), when the harness reports plans it cannot read, when a repo has no .claude/DIRECTOR.md, or when the director offered onboarding at boot and the user said yes. Reads before it writes; every write is shown as a diff.
argument-hint: [optional focus — plans | director | skills]
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, AskUserQuestion
---

# /director-skills — onboard a repo to the director workflow

The [director harness](https://github.com/dannybrian/beth) is one
contract with two halves: the harness supplies the director's ROLE; the repo
supplies the PERSON (`.claude/DIRECTOR.md`), the WORK (`plans/`), and the
machinery that keeps both honest (`/plans`, `/tidyrepo`). This skill supplies
the repo half — from templates where the answer is mechanical, by interview
where the answer is a person.

Templates live in `templates/` beside this file. This skill is usually a
symlink from `~/.claude/skills/director-skills` into the harness checkout —
resolve the real path first:

```bash
SKILL_DIR=$(dirname "$(readlink -f ~/.claude/skills/director-skills/SKILL.md)")
HARNESS=$(cd "$SKILL_DIR/../.." && pwd)
```

## Diagnose before writing anything

Inventory the repo and decide which of three states it is in. Report the state
and the evidence BEFORE proposing changes.

```bash
ls .claude/DIRECTOR.md 2>/dev/null          # the person
ls plans/ 2>/dev/null | head                # the work, default root
ls .claude/skills/plans 2>/dev/null         # the machinery
# plans-shaped files outside the default root:
find . -path ./node_modules -prune -o -name '20*-*.md' -print 2>/dev/null | grep -v '^./plans' | head
```

**State 1 — greenfield.** Nothing plans-shaped anywhere → run every section
below in order.

**State 2 — plans exist but the harness can't read them.** Escalate cheapest
first:

1. *Wrong place, right shape?* Run the files through the harness's REAL parser
   — never guess at compatibility:
   ```bash
   node -e "
   import('$HARNESS/src/plansReader.ts').then(async (m) => {
     const r = m.createPlansReader({ repo: process.cwd(), roots: ['THEIR_DIR'] });
     const items = await r.read();
     console.log(items.length, 'parsed');
     for (const i of items.slice(0, 5)) console.log(' ', i.status, i.path, JSON.stringify(i.title));
   });"
   ```
   If they parse: the fix is one line — `HARNESS_PLAN_ROOTS=THEIR_DIR` in the
   repo's `.env`. Done; skip migration entirely.
2. *Right place, missing frontmatter?* Add ONLY the missing keys (see the
   schema in `templates/plans/README.md`), preserve every other byte, show the
   diff per file. Batch by directory; confirm before writing.
3. *Foreign source* (Linear, issues, a tracker)? v1 answer is a one-time
   export to dated markdown in `plans/` — write the exporter with the user,
   in their repo. Do NOT attempt a live reader; that seam is deferred
   (see `$HARNESS/docs/director-skills.md`).

**State 3 — parses but partial.** Name exactly what is missing (DIRECTOR.md?
role-lock plan? statuses falling to `unknown`? no `/plans` skill?) and run only
the matching sections below.

## Bootstrap the format (copy, don't invent)

Every generated file keeps its provenance line. The repo owns its copies
afterward — there is no sync, by design.

1. **Plans directory**, if missing:
   ```bash
   mkdir -p plans/future
   cp "$SKILL_DIR/templates/plans/README.md" plans/README.md
   cp "$SKILL_DIR/templates/plans/TEMPLATE.md" plans/TEMPLATE.md
   ```
2. **Role-lock plan**: copy `templates/plans/role-lock.md` to
   `plans/YYYY-MM-DD-director-role.md` (today's date), replace `DATE`
   placeholders, and add `HARNESS_DIRECTOR_PLAN=plans/YYYY-MM-DD-director-role.md`
   to the repo's `.env`.
3. **The `/plans` skill**:
   ```bash
   mkdir -p .claude/skills
   cp -R "$SKILL_DIR/templates/skills/plans" .claude/skills/plans
   ```
   - ⚠️ The CLI finds the repo root by walking up to a `CLAUDE.md`. A repo
     without one needs at least a stub before `/plans` works.
   - If plans live outside `plans/`, edit `PLAN_TREES` in
     `.claude/skills/plans/index.mjs` — one visible line.
   - Verify on the spot: `node --test '.claude/skills/plans/**/*.test.mjs'`
     (the suite is location-aware and must pass from the repo), then
     `node .claude/skills/plans/index.mjs` for the empty board.
   - Wire the Stop-hook heartbeat if the repo uses hooks: a `Stop` hook running
     `node .claude/skills/plans/index.mjs tick --quiet`.
4. **`/tidyrepo`**: copy `templates/skills/tidyrepo` the same way. Its
   "Project-specific rules" section starts empty on purpose — it grows scar
   tissue per repo.
5. **Gitignores**: `.claude/sessions/` (session ledger) and
   `.claude/events.jsonl` (harness event log) must not be committed.
6. *(Optional, later)* commit-trailer git hooks — see the reference repo's
   `.claude/githooks/`. Deepest integration, least required; skip in v1 unless
   asked.

## Interview the person (never copy one)

A copied DIRECTOR.md is the generic stranger the harness already provides for
free. Ask — one `AskUserQuestion` round, then write from the answers into
`templates/DIRECTOR.md`'s structure at `.claude/DIRECTOR.md`:

1. **Name** — what is this director called? (And who are they talking to —
   default the git user's first name.)
2. **Manner** — how do they talk, and specifically how do they deliver bad
   news? The template's `{{MANNER}}` note has the prompts.
3. **What they push on** — the bias: shipping, correctness, scope honesty.
4. **What they refuse** — including any production-access rule this repo needs.

Where the inventory already answered a question (state 2 found where work
lives), don't ask it again.

Mention at the end: a persona file (`~/.director-harness/personas/`) can carry
the same person ACROSS repos, and this DIRECTOR.md composes with it — the
persona says who she is, this file says what this project needs from her.

## Verify the whole contract

The point of the exercise is that the harness's panel lights up:

1. `node .claude/skills/plans/index.mjs new first-real-plan` — scaffold
   something real from the interview conversation, even small.
2. Restart the harness (`beth`) in the repo. The greeting should name the
   director; the panel should show the plan; the role-lock plan should NOT
   appear on the board.
3. If anything is missing, that is a diagnosis bug in this skill — report it
   in the harness repo rather than hand-patching silently.
