# /director-skills — the repo-side contract, made executable

*Design record, 2026-08-06. Status: agreed, built alongside this record.*

## The problem

The harness's whole design is one contract with two halves: the harness supplies
the director's ROLE, and the bound repo supplies everything else — the PERSON
(`.claude/DIRECTOR.md`), the WORK (`plans/` in the shape `plansReader` parses),
and the machinery that keeps both honest (`/plans`, `/tidyrepo`). The harness
half is documented and shipped. The repo half existed only as folklore: in
Danny's head, and in beadgame's files as the reference implementation nobody
else can see.

So the failure mode for any new repo — including Danny's own next project — is
silent: `beth` binds, a competent unnamed director answers, the panel is empty,
and nothing says the interesting parts are unreached. The README could describe
the repo-side format in prose, but prose format docs and a parser WILL drift,
and the parser wins every time.

`/director-skills` is the fix: **executable documentation of the contract**. A
skill that reads the repo, says where it stands against the contract, and
supplies the missing half — from managed templates where the answer is
mechanical, by interview where the answer is a person.

## Why a skill, and not the harness

The harness only reads. That rule survives this feature untouched: the skill is
invoked by *Claude in the bound repo* — the director session or any terminal
session — and writes files exactly as a developer would, conversationally, with
diffs shown. The one harness change is that the greeting can now OFFER the
skill (below). Nothing in `src/` writes a plan file, a guide, or a skill into
any repo. `planName.ts` remains the one narrow exception it always was.

## Diagnosis first — the three entry states

"Missing our plans" is not binary. The skill inventories before it writes, and
what it finds picks the conversation:

1. **Greenfield.** Nothing plans-shaped anywhere. Bootstrap the format from
   templates, then interview for the person.
2. **Plans exist, the reader can't see them.** The interesting case, with an
   escalation ladder where each rung is cheaper than people assume:
   - *Point the roots.* `HARNESS_PLAN_ROOTS` already redirects the reader —
     one line in the repo's `.env`, zero file changes. Files that look
     plans-shaped outside the default root are run through the REAL parser
     first and the result reported. A measurement, not a compatibility guess.
   - *Light migration.* Right place, missing frontmatter — add the keys,
     preserve every other byte, show the diff. In an established convention
     this repair belongs to `/tidyrepo`; a repo being onboarded has no
     `/tidyrepo` yet, so the skill is CREATING the convention and may write.
   - *Foreign source* (Linear, issues, a bespoke tracker). v1 answers this
     with a one-time export-to-markdown migration, not a live reader — see
     Deferred.
3. **Parses but partial.** Plans work but there is no `DIRECTOR.md`, or no
   role-lock plan, or statuses falling to `unknown`. Name the gaps, fix only
   those.

## Bootstrap the format, interview the person

The split that resolves "walkthrough or templates or both":

- The **format** — directory layout, frontmatter schema, the closed status set,
  dated filenames, the role-lock plan, the `/plans` CLI, `/tidyrepo` — is
  mechanical, has one canonical right answer, and is COPIED from templates.
  Inventing it fresh per repo is how frontmatter drifts into shapes the reader
  silently half-parses.
- The **person** — `DIRECTOR.md` — is interviewed, never copied. A copied
  template gives you the generic stranger the harness already gives you for
  free with no file at all. The interview: where does work live in this repo
  (state 2 answers this from the inventory before asking); what is she called;
  her manner, and how she delivers bad news; what she pushes on; what she
  refuses. The last three are the same questions the persona stub asks, because
  they are the same questions.

## Delivery: skills load from the repo you are standing in

A skill carried in this repo is only invocable with cwd HERE — but the moment
of need is in some OTHER repo. Resolution:

- **`/director-skills` alone goes user-level**, symlinked:
  `ln -sf ~/Sources/beth/skills/director-skills ~/.claude/skills/director-skills`.
  Same pattern as `bin/beth.mjs` and the personas directory: this repo is the
  source of machine-level things without shipping project things. The symlink
  also means the skill can find its own templates (and the harness's parser,
  for verification) by resolving its real path.
- **`/plans` and `/tidyrepo` are bootstrapped repo-level** into the target's
  `.claude/skills/`, under their own names. No namespace prefix: repo-level
  skills cannot collide across repos, the names are the convention the
  reference repo already uses, and prefixing new copies would diverge every
  new repo from the one worked example. (If a namespace is ever wanted for
  more user-level skills, it is `director-*`, not a persona's name — personas
  are one person's, on one machine, as of 2026-08-06, and baking one into
  machinery is the "editing the tool to hire a colleague" mistake.)

## Templates: copy once, then the repo owns its files

Managed templates live in `skills/director-skills/templates/`. The `/plans` CLI
is a VENDORED SNAPSHOT of beadgame's (~4k lines including its test suite, one
constant `PLAN_TREES` reduced to `['plans']` and called out in the walkthrough
for repos that keep plans elsewhere). Copied wholesale on purpose: rewriting a
minimal tracker throws away tested machinery and starts drift on day one.

The drift rule is `seedMemory`'s rule: **copy once, no sync, no version
pinning.** After bootstrap the repo owns its files, exactly as beadgame owns
its. Each generated file carries one provenance line naming the template and
date. If template drift ever actually hurts, that is a future "re-run with a
diff" feature — ceremony when something hurts, not before.

## The greeting offer

The harness already knows, at boot, that a repo has no `DIRECTOR.md` (the
console line nobody reads) and whether the index found zero items while a
plans-shaped directory sits there unread. That knowledge becomes kickoff
MATERIAL — same mechanism as branch/dirt/last-commit — so the offer arrives
with evidence: "you have 34 files in `plans/` I can't read" is a colleague;
"want me to set up plans?" is a wizard.

Constraints that held elsewhere hold here:

- **Once, ever, per repo.** Tracked in the state dir like the personal beat's
  `lastBeatAt`. Most boots say nothing; a declined offer never repeats. Danny
  can always invoke `/director-skills` himself.
- **The boot line stays ONE sentence.** The offer rides as material the model
  folds in, not as a second instruction — a second thing to say is what made
  the greeting speak three times (see `greeting.ts`).

## Deferred, explicitly

- **A repo-supplied reader seam.** CLAUDE.md says a project with foreign work
  "supplies its own reader," but today that means editing `main.ts` in THIS
  repo, which contradicts the sentence. A real seam (say,
  `.claude/director/reader.ts`, dynamically imported when present) loads
  repo-authored code into the HARNESS process — a different trust boundary
  from the director session executing code in the repo, even though practical
  exposure is similar once the handoff can spawn shells. Deferred until a
  foreign-work repo actually exists; v1's answer is migration.
- **Template sync / re-run with diff.** See the drift rule.
- **Commit-trailer git hooks** (`prepare-commit-msg` / `post-commit`). The
  deepest integration and the least required for the panel to light up. The
  walkthrough names them as an optional later step, pointing at beadgame's
  `.claude/githooks/` as the reference.

## What was actually built

- `skills/director-skills/` — SKILL.md + templates (this record's companion).
- Greeting: onboarding facts + the once-ever offer (`greeting.ts`, `main.ts`,
  state file `onboarding.json`).
- This repo's own `.claude/DIRECTOR.md` — the harness repo eats half its own
  dogfood: a person, but deliberately NO plans machinery, per the Process
  section of CLAUDE.md. The plans exemplar is the templates directory itself.
- README rewritten first-person around the contract, with `/director-skills`
  as the on-ramp and prose format-docs deliberately absent.
