# Personal context — a director who remembers you

> **BUILT**, 2026-08-02 — `src/personal.ts`, `remember`/`recall` in `tools.ts`, the beat
> at the two moments in `main.ts` and `session.ts`. Verified end to end: mentioned in
> passing, recorded unprompted, followed up unprompted a session later, marked asked so it
> cannot repeat.
>
> One deviation from what is written below. The design has `asked` as a field ON the entry,
> but the file is append-only for the same reason the event log is — so the follow-up
> arrives as its OWN record (`{kind:'asked', ref}`) and is folded out on read. Same
> information, no rewrite, and the history of what was asked when survives.
>
> One addition: the "long gap" that makes a turn an arrival rather than mid-work is three
> hours (`GAP_MS`). Any shorter and a lunch break reads as a new day.

> Danny, 2026-08-01: *"I'd like it if Beth stored/retained personal context about me;
> asked me how I am once a day or so, or asked me how such-and-such went."*

Everything the harness remembers today is about the WORK: plans, claims, pending
decisions, an event log. Nothing remembers the person. Every session she meets you for
the first time, which is why the greeting is always the same shape and why she never
follows anything up.

This is a small feature with an easy failure mode, so the design is mostly about the
failure mode.

## What it is not

It is not a mood engine, and it is not a rapport script. A director who opens with "How
are you feeling today?" every morning is a form with a face on it, and the third time you
answer it you stop answering honestly. The value is entirely in the FOLLOW-UP: she asked
about the demo on Thursday because there was a demo on Thursday and she knew it.

So the rule is: **she may only ask about something she actually knows.** No open-ended
check-ins on a timer. A question comes from a recorded fact with a date attached, or it
does not get asked.

## The store

A single JSONL file beside the other per-repo state — `~/.director-harness/<repo>/
personal.jsonl` — because this is about Danny, not about the project, and it must never
land in a repo that gets pushed. (Machine-wide is arguably righter, since he is the same
person on every repo; per-repo is the safer default and the cheaper thing to change
later.) Append-only, same as the event log, so nothing is silently rewritten.

Each entry is small and typed:

```jsonc
{ "ts": "2026-08-01T14:05:00Z",
  "kind": "thread",              // thread | preference | state | fact
  "text": "Demo for the tulito folks on Thursday — nervous about the geo pins",
  "due": "2026-08-07",           // when following up stops being useful
  "asked": null }                // set when she has followed up, so she does not repeat
```

- **thread** — something with an outcome she can ask about later. The only kind that
  generates a question.
- **preference** — how he likes to work ("commits and pushes are his, not hers").
- **state** — sleep, travel, a bad week. Decays fast; useful for tone, not for asking.
- **fact** — durable and dull. Timezone, working hours, who "the tulito folks" are.

Two tools, mirroring `say`/`pending`: `remember` (one item per call, with a kind and an
optional `due`) and `recall` (read them back). She writes an entry when he tells her
something in passing, not by interrogating him — and the prompt should say exactly that,
because a model given a memory tool will otherwise use it to take minutes.

## When she asks

At most one personal beat per day, and only at a moment that is already hers: the boot
greeting, or the first turn after a long gap. Never mid-work — the whole point of the
harness is that she protects your attention, and interrupting a debugging session to ask
how your week is going is the opposite of that.

The check is mechanical, so it cannot drift into chattiness:

- a `thread` whose `due` has passed and whose `asked` is null → *"How did the tulito demo
  go?"*, and mark it asked whether or not he answers,
- otherwise, if nothing personal has been said in ~24h and the last exchange did not end
  mid-task → one light check-in,
- otherwise nothing at all. Silence is the default, and most days should hit it.

`HARNESS_PERSONAL=off` disables the whole thing, and the disabled path must be genuinely
silent rather than "she stops asking but still records" — someone who turns this off is
saying don't keep a file on me.

## What it costs

The recall has to reach the model to be worth anything, which means the recent entries
ride the system prompt: a few hundred tokens on a prefix that is already tens of
thousands. Cap it — most recent N, plus anything with an unasked `due` — so the file can
grow for years without the prompt growing with it.

## Why this is worth building

She is a standing director you talk to by voice all day. The thing that makes that
relationship work in real life is not recall of facts, it is that the other person
noticed. Following up on the demo, once, unprompted, is worth more than any amount of
"how are you feeling today" — and it is a twenty-line file and one tool call to get it.
