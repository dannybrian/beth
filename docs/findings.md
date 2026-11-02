# Findings — what widened the work, collected

> Danny, 2026-11-02: *"we should have a way to collect and report those findings for my
> benefit. A pull request isn't it."* And, of where they already are: *"the plans contain
> most of it."*

BUILT 2026-11-02 — all six steps. Asked for by the beadgame director, planned here
because the reading half is the harness's; Danny agreed the marker, and beadgame's
director skill and constitution require it in done notes the same day. Verified on a
scratch repo: the first boot seeded an existing finding as read, one appended live
arrived unread in the panel, the reader opened the shipped plan at its line, ✓ and "show
all" behaved, and her `plans` tool answered from the digest.

⚠ Building step 4 found a bug the line test exposed in `ui/md.js`: a blank line after a
nested sub-list was swallowed, so the NEXT unindented block (a heading, a fence, a
paragraph) was glued onto the last bullet as text. 138 of 903 real plans across beadgame
and tulito parsed differently after the fix, and every one of them only gained blocks —
"## Verification" had been rendering as the tail of a bullet.

## Why now

Beadgame's plan 305 ran two days where Danny expected far less. Each review found another
hidden input: decal draw order, physics on the wall clock, the sky crossfade, candles,
wind, ribbons. Beadgame's constitution now has a ledger rule (2026-11-02): a finding that
materially widens a plan is told to him in a `say` at the moment it lands, and the work
keeps going. That covers *as they land*. Nothing covers *afterwards*: "what widened the
work since I last looked" has no answer short of reading 2,000-line plans.

## What is already there, measured

From beadgame's 821 plan files:

- **The findings are in the plans, written by workers in done notes.** In 305 they look
  like `**Found while fixing:** Bag1 has no GlintController…` under `### T1a-fix — done
  2026-11-01`, plus a reviewer's `### Danny items`.
- **The marking is free-form.** 25 files carry a bold `**Found…**` lead, and almost every
  lead is different: `Found:`, `Found while fixing`, `Found on the way`, `Found on the way,
  not ours`, `Found, not changed`, `Found for M5`. A loose `**Found` match also hits
  `**Foundation B — entitlements**`.
- **`## Findings` means something else.** 12 files have that heading, and the ones
  sampled are research results (a lexicon gap analysis, a behaviour experiment), not
  "this widened the work".
- **The event log can't help as it stands.** `say` already takes `kind: 'finding'` and a
  `ref` (`tools.ts`). But the event appended is `kind: 'say'` with the finding kind
  dropped, so 419 says sit among 34,751 rows with nothing to tell a finding from a status.

So a parser over what exists today would be guessing, and its guesses would be wrong in a
way that looks right. That is the `md.js` failure class: confident, well-formed and wrong.
The fix is a convention first and a strict reader second.

## The shape

### 1. One marker, written by whoever finds it

A finding is two bold-led lines, together, anywhere in a plan body (normally in the done
note of the task that turned it up):

```markdown
**Finding 2026-11-01:** Bag1 has no `GlintController`, so the bag app draws no glint at
all; R305-4's "sway now frozen" held only for an Editor session with lingering globals.
**Adds:** a new cause class (globals surviving a scene change) and T1e to pin it.
```

- **The date is in the lead** because "since he last looked" and the digest's order both
  need it, and a plan body has no other trustworthy per-paragraph date.
- **`Adds:` is required.** That line is what Danny asked to understand: not that something
  was found, but what it did to the work. A discovery that adds nothing is ordinary done-
  note prose and should not be marked. The marker means *widened*, and keeping it to that
  is what keeps the digest worth opening.
- **The lead is exact:** `**Finding YYYY-MM-DD:**`. No `Found`, no variants. Strictness is
  the point. It does not collide with any of the 25 existing `**Found…**` leads, nor with
  `## Findings` sections, so adopting it leaves the old plans alone. **No backfill.** The
  legacy variants are not parsed; that guess is the bug described above.

**Where the convention is written down:**
- **The harness's half:** `skills/director-skills/templates/plans/README.md`, under
  Authoring standard, so every bootstrapped repo gets it.
- **Beadgame's half:** the director's worker briefs and its constitution's ledger rule.
  The `say` and the marker are the same event told twice: once aloud, once on file.

### 2. The reader extracts them

`plansReader` already parses tasks out of each plan body (`parseTasks`, fence-aware). A
`parseFindings(lines, from)` beside it returns:

```ts
type Finding = {
  date: string;       // from the lead
  text: string;       // the finding, markers stripped (the panel is 300px)
  adds: string;       // the Adds line; a Finding without one is not a Finding
  line: number;       // 1-based, for the reader to open at
  under?: string;     // nearest heading above it: "T1a-fix — done 2026-11-01"
  id: string;         // plan path + hash of date and finding text; see Read state
};
```

`WorkItem` grows `findings: Finding[]`. The same fence rule as tasks applies: a marker
inside a code fence is an example, like the one in this doc, not a finding.

⚠ **Findings live on FINISHED plans.** 305 is `shipped`. The digest is therefore computed
over `work.all()`, never the live slice, and never off the page's `byPathAll`. This is the
trap CLAUDE.md records as having bitten three times.

### 3. The digest, in the plans panel

**A Findings strip at the top of the plans panel:**
- It shows only when something is unread, as "3 findings since you last looked".
- Opening it lists unread findings grouped by plan, newest first. Each row shows the
  finding, its `Adds:` line, and the done note it sits under.
- **Clicking a row** opens the plan reader AT that line. That is new: `md.js` blocks
  carry no source line today, so the parse gains one per block. That part is pure and
  tested in node, like the rest of `md.js`.
- **Marking read:** ✓ on a row, or "mark all read". Everything already read stays
  reachable under "all findings", so the strip is never the only record.

**Read state is Danny's attention on one machine**, the same argument as pins. It lives
in the state dir (`findings-read.json`), and no plan file learns about it. The harness
still only reads plans.
- **Identity:** a finding's id is its plan path plus a hash of its date and its
  whitespace-collapsed text, so a rewrap keeps it. If a worker later rewrites a finding's
  text, it returns as unread. That is arguably right (it
  changed) and at worst a repeat. It is never a silent loss.
- **First boot seeds the read set** with everything already marked, the same rule as the
  inbox and the decisions queue, so adopting the feature does not open with a backlog.

**Not announced.** The ledger rule already has her `say` each finding as it lands. A
second announcement from the index would make every finding heard twice, which is the
CLAUDE.md corollary about hearing things twice. The digest is for collecting, not
summoning.

### 4. Hers, by voice

"What widened the work this week?" is said out loud, so her `plans` tool gains
`findings: true`. It returns the unread findings (or, with `scope: 'all'`, all of them),
grouped by plan, with their `Adds:` lines. She reads; Danny marks read. Her answering does
not mark anything read, because she can't know he heard it.

### 5. The spoken findings, recorded properly

The one-line fix in `tools.ts`: the `say` event keeps its kind (an optional `sayKind` on
the event, leaving `kind: 'say'` alone for anything already reading the log). Spoken
findings then become queryable by plan ref, cheaply, from now on.

**Reconciling** spoken against filed ("she said three, the plan has two") is set aside:
matching a sentence to a paragraph is fuzzy, and a fuzzy match that looks resolved is
worse than none. The recorded kind is what makes it possible later.

## Steps

1. **The convention:** the template README text, plus a director-skills note that the
   marker is the on-file half of the `say`. Beadgame adopts it in its briefs (its side,
   done there).
2. **`parseFindings` and `WorkItem.findings`**, with tests on real plan text. Use 305's
   T1a-fix note rewritten in the new marker, plus a fence containing one and the
   `**Foundation…**` and `## Findings` near-misses, all pasted, not invented.
3. **`/api/findings`** over the whole corpus, the read-state store, and the first-boot seed.
4. **The panel strip and list**, and the reader opening at a line (`md.js` block lines,
   tested).
5. **`plans` tool `findings: true`.**
6. **`sayKind` on the say event.**

Steps 1 and 6 are independent and small. Step 2 is the one that must be right before
anything renders it.

## Set aside

- **Parsing the legacy `**Found…**` variants.** Too varied to read without guessing, as
  measured above. If Danny wants 305's findings in the digest, someone rewrites those few
  in the new marker by hand. Plan files belong to `/plans`, so that is not the harness's
  job.
- **Reconciling spoken with filed findings.** See step 5.
- **A ruling line** (`**Ruled 2026-11-01 (Danny): …**` already appears under findings). A
  finding with a pending ruling would be a decision, and decisions have their own queue.
  Revisit if findings and rulings start being asked about together.
- **A per-plan badge** ("2 new findings") on rows. The strip answers "since I last
  looked"; badges would answer "which plan", which the grouped list already shows.

## What would flip this

- **Workers ignore the marker.** If findings keep arriving in free-form prose after the
  convention is in the briefs, the problem is the brief, not the parser. Strengthen the
  brief; do not loosen the parser.
- **Another repo's plans already use a different consistent marker.** Then the lead
  becomes reader configuration, which is the `WorkReader` seam's job, rather than a second
  hardcoded pattern.
