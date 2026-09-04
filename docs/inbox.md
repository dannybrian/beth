# The inbox — hand-offs from other agents and apps

> Danny, 2026-09-04: *"We really need a way for other agents/apps to be able to put
> something into a queue or task list for the directors."* It came out of the voice
> memo work: he has started addressing an assistant directly in memos — instructions,
> and to-dos meant for a director — and nothing carries them from there to here.

Agreed 2026-09-04, and BUILT the same day through step 3: `src/inbox.ts` (the parse,
the reader, the acks), the `inbox` status, the refusals, `close_inbox`, `/api/inbox`,
the panel group, the summons and the greeting material — verified on a throwaway
harness with a fixture outbox (arrival spoke and wrote its line, ✓ moved the row to
shipped, an appended record showed within the debounce). Step 4, the producer, is
Memobase's and is recorded in that repo's `PLAN.md`, item 7a. The rest of this record
is the design as agreed, kept for the reasoning.

## What this is, and what it is not

A director gets a queue that OTHER processes can put things on: a file they append to
and she reads. It rides the seam the harness already has for work — `WorkReader` in
`workItems.ts` — so a hand-off is a work item like a plan: it is on the board, it can be
pointed at, it has a spoken name, and its arrival is a summons.

It is not an API. The harness has no write endpoint for work and must not grow one:
that would couple every producer to a running process, and it inverts the rule that the
harness only READS what a project stores. It is not a broker either. An append-only log
with per-consumer cursors is the minimal queue, and if a second consumer with real
delivery needs ever shows up, this log is exactly what would be replayed into one.
Building the broker now is a bet on consumers that do not exist.

Two things it deliberately does not do:

- **The pull direction.** A director asking the memo archive questions is a different
  integration — a thin server over Memobase's `query.py`, the MCP-ish connector Danny
  has mused about. Push and pull coexist without either knowing about the other, and
  the pull half lives with the producer, not here.
- **Deciding what is a hand-off.** Only the producer sees the memo. The guardrail —
  a memo that opens with the assistant's name is addressed, a to-do inside it is a
  hand-off, everything else is surfaced and never queued — is the producer's, and the
  cheapest reliable signal is the address itself. The harness treats every record it
  reads as a hand-off by definition.

⚠ **The harness must not learn the producer.** The first proposal was "Beth supplies a
Memobase reader", which is the right seam and the wrong owner: a reader that parses
Memobase's schema teaches the harness about a specific project, the one thing
`CLAUDE.md` says to resist. So the harness defines the SHAPE of an inbox record and
where it looks for them; a producer writes that shape. Memobase's outbox is written to
satisfy it, its extra fields ride along ignored, and nothing in this repo names Memobase.
Same contract as the work item itself: the harness owns the shape, the source owns
the data.

## The shape

```
  producer (Memobase's index step, any script, another agent)
      │  appends one JSON line per hand-off; never edits, never deletes
      ▼
  ~/.director-harness/inbox/*.jsonl          ← the default drop; plus HARNESS_INBOX files
      │
      ▼  (every running harness reads every file — a hand-off is addressed to a
      │   DIRECTOR, not a repo, so the file is machine-level like the personas)
  inboxReader (WorkReader)  ──►  WorkIndex  ──►  panel group "Inbox" · pending · greeting
      │
      └─ acks: <stateDir>/inbox.json         ← hers, per repo, never in the producer's file
```

### The record

One JSON object per line. Required, harness-defined:

| field  | meaning |
|--------|---------|
| `id`   | Stable and unique within the file. Identity is `(file, id)`; a producer that rotates files must not reuse ids across them. |
| `at`   | ISO timestamp of the hand-off. |
| `text` | What is being handed off, already polished. Markdown allowed. |
| `from` | The producer's name, for the row and the spoken line. |

Optional: `to` — a director's name (see addressing); `title` — else the first line of
`text`; `ref` — the source, opaque to the harness (a memo path, a URL), shown as text
and never opened. Unknown fields are ignored, which is how a producer's superset (a
source id, a confidence, a category) rides along without a schema negotiation.

Rules, and each is a test:

- **Append-only, one `write` per record, newline-terminated.** The harness never
  writes, truncates, or rotates. A correction is not an edit — retraction is set
  aside (below) until use asks for it.
- **A malformed line is skipped and counted, never fatal.** A producer bug must not
  blank the board. The count reaches the terminal (`work:` line) so it is not invisible.
- **A partial last line is a writer mid-append.** Skipped this pass, picked up on the
  next; the read is whole-corpus per the `WorkReader` contract, and that is cheap here
  because hand-offs are rare.
- **The producer never tracks status.** Consumers keep their own cursor and their own
  acknowledgements. That keeps the producer ignorant of every downstream, which is the
  focus Memobase needs to keep.

### Where it lands: a reader, with a status of its own

`inboxReader.ts` is a built-in `WorkReader` beside `plansReader.ts`, wired in
`main.ts`. `watchRoots()` is the inbox directory plus the directory of each
`HARNESS_INBOX` file. The item's `path` is SYNTHETIC — `inbox/<file-stem>/<id>` — and
that has consequences the plans machinery must be made to refuse rather than left to
find out:

- `/api/plan` already refuses (`resolveMarkdown` allows only real markdown inside the
  repo), so the reader modal cannot open it. The panel renders `text` inline instead;
  that IS the content, there is no file behind it.
- `/api/handoff` must refuse a synthetic path (`canHandOff`), tested — the alternative
  is Claude Code spawned at a path that does not exist.
- Rename (`planName.ts`, the one writer) must refuse it: there is no frontmatter and
  no file, and the rule that forbids creating one holds twice over here.

**A new status, `inbox`, first in `LIVE`.** None of the existing vocabulary fits: a
hand-off is not in flight (nothing is running), and it is not `awaiting-eyes` — that
means finished except for Danny, and this is the opposite, not started and waiting for
someone to take it. Borrowing either would make the board lie in the way the
`awaiting-eyes` comment warns about. It goes ahead of NEEDS_EYES because it is the one
pile that arrived from OUTSIDE the conversation and nothing else on the page announces
it. Once acknowledged, an item leaves the live set: `done` renders as `shipped`,
`dismissed` as `parked`, both under "show all" — nothing is ever deleted from the
producer's file, so nothing is ever lost.

**The acks are hers, like pins.** `<stateDir>/inbox.json`, keyed by `(file, id)`:
`{ state: 'done' | 'dismissed', at, ref? }`. The producer's file is never touched;
one person's decision about one hand-off on one machine belongs in the state dir, and
`pins.ts` is the pattern. The `ref` is for the common outcome — she took it into a plan
— so the row links to what it became; the plan itself is written by the repo's `/plans`,
never by the harness. Two harnesses on one repo share the state dir and so share the
acks, which is correct. Her tool is `close_inbox(id, state, ref?)`, the panel offers ✓
and × on the row, and both publish, the same shape as `close_decision`.

The proposal was her existing event log for acks. It is close and wrong: that log lives
in the BOUND REPO and records work done there, while a dismissed hand-off is attention,
not work. Taking one INTO a plan is a repo event, and that is what the `ref` records.

### Addressing

`to` is matched, case-insensitively, against the director's name — the persona's if one
is in the room, else the repo's (`directorName.ts`). A record addressed to her shows in
her panel; one addressed to someone else does not exist here. An UNADDRESSED record
shows to every running director, because the producer could not say who it was for and
hiding it everywhere is the wrong default. A record addressed to a director who is not
running is shown by nobody — that is the desk's summons strip's problem when the desk
exists (`desk.md`, step 3), and not a reason to guess here.

A name is an addressing protocol, and a queue needs addresses at both ends. That is the
identity point from the memo work, and it is why the name only makes sense once
something answers to it: this is the something.

### Arrival is a summons, not a turn

A new `(file, id)` since the last read is announced the way a queued decision is: an
`event` on the bus (kind `handoff`, text `<from>: <title>`), spoken at every level except
`off`. ⚠ The seen-set is SEEDED from the first read, exactly as `speakOut.ts` seeds it
from the first `pending`: the reader restores the whole backlog at boot, and an empty set
reads it all aloud every morning. Same trap, same fix, and the test is the same shape.

⚠ `fs.watch` stops delivering across a macOS sleep and fails silently (`voiceRoom.ts`
learned this the hard way). Hand-offs arrive precisely while he is away from this
machine — a memo on a walk, indexed when he is back — so the reader keeps a slow poll
beside the watcher the way the room's dial does. It publishes only on change.

**It does not start a turn.** A session that runs shells acting on a file another
process wrote, with nobody watching, is the trust model `desk.md` set aside with the
assistant director, and this is not the door to reopen it through. Instead the queue is
where she already looks: it rides `pending` and the `plans` tool answer so she knows on
the next turn, and the count is greeting MATERIAL (`greeting.ts` — "two hand-offs from
Memobase waiting" is a fact that differs by the day, which is what the greeting wants;
⚠ material, not a second instruction, per the three-times-"I am here" lesson).

## What Memobase does — one producer, unknown to the harness

Recorded here only so the two sides agree; the harness does none of it. The index step
appends a record per hand-off with `from: memobase`, `ref` the memo path, `to` the name
the memo opened with, and `text` the polished to-do. ⚠ The hand-off flag is DERIVED at
index time from the extracted to-dos and the memo's opening, never added to the
extraction schema: a schema field changes the prompt hash and re-analyses the entire
archive. The file is Memobase's outbox in its own data dir, named to the harness by
`HARNESS_INBOX` in the machine `.env` — one Memobase per Mac, like one ElevenLabs
account, so a per-repo setting would be the same duplicate-and-forget mistake.

## Steps

1. **Format and reader** — `inboxReader.ts`, `inbox` status, the synthetic-path refusals.
   Tests: a malformed line among good ones, a partial last line, `to` matched and
   unmatched, unaddressed shown, ids unique per file. ⚠ Once Memobase writes a real
   line, replace any invented fixture with it — `CLAUDE.md` on invented fixtures.
2. **Acks** — the store, `close_inbox`, the panel group with ✓ and ×, `done`/`dismissed`
   out of the live set. Test that an ack survives a restart and that nothing touches the
   producer's file (hash it before and after).
3. **Summons** — the `event`, the seeded seen-set, the poll beside the watcher, the
   greeting material, the `pending`/`plans` surfacing.
4. **The producer** — in the Memobase repo, against this format. Still open: steps
   1–3 landed 2026-09-04, so the format above is what it writes to.

## Set aside

- **An API or a broker** — above. The log is the queue until a consumer needs more.
- **Retraction / supersede records** — a producer that changes its mind. Nothing needs
  it yet; the shape it would take is a record with `supersedes: id`, read by the same
  reader. Add it from a real case, not from here.
- **A channel back** — the director answering the producer. The ack `ref` is as much
  as anyone has asked for; a reply is the pull direction's job if it is anyone's.
- **A per-repo inbox** — a hand-off addressed to a repo rather than a person. Every
  case so far is addressed to a name, and a repo-level drop would need the desk to
  route it anyway.
