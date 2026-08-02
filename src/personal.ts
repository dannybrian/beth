// A director who remembers the person, not only the work.
//
// Everything else the harness keeps is about the WORK — plans, claims, pending
// decisions, an event log. Nothing remembered the person, so every session she
// met Danny for the first time, which is why the greeting was always the same
// shape and why she never followed anything up.
//
// This is a small feature with an easy failure mode, so most of the design is
// about the failure mode. It is NOT a mood engine and NOT a rapport script: a
// director who opens with "how are you feeling today?" every morning is a form
// with a face on it, and the third time you answer it you stop answering
// honestly. The value is entirely in the FOLLOW-UP — she asked about Thursday's
// demo because there was a demo on Thursday and she knew it.
//
// So the rule is: she may only ask about something she ACTUALLY KNOWS. A question
// comes from a recorded fact with a date attached, or it does not get asked.
import fs from 'node:fs';
import path from 'node:path';
import type { HarnessConfig } from './config.ts';

export type PersonalKind = 'thread' | 'preference' | 'state' | 'fact';

export type PersonalEntry = {
  ts: string;
  kind: PersonalKind;
  text: string;
  /** thread only — when following up stops being useful. */
  due?: string;
};

/**
 * The follow-up has happened, for the entry written at `ref`.
 *
 * The design record models this as an `asked` field ON the entry, but the file is
 * append-only for the same reason the event log is — nothing here is silently
 * rewritten — so it arrives as its own record instead. Same information, no
 * rewrite, and the history of what was asked when survives.
 */
type AskedMarker = { ts: string; kind: 'asked'; ref: string };

type Line = PersonalEntry | AskedMarker;

/** Entries riding the system prompt. A few hundred tokens on a prefix that is
 *  already tens of thousands — but the file can grow for years, so it is capped. */
const PROMPT_RECENT = 20;

/** A gap long enough that the next turn is a fresh arrival rather than mid-work. */
export const GAP_MS = 3 * 60 * 60_000;

export class PersonalStore {
  private file: string;
  private stateFile: string;
  readonly enabled: boolean;

  constructor(cfg: HarnessConfig) {
    // Per-repo, beside the other state. Machine-wide is arguably righter — he is
    // the same person on every repo — but per-repo is the safer default and the
    // cheaper thing to change later. It must never land in a repo that gets
    // pushed, which is why it is here rather than in .claude/.
    this.file = path.join(cfg.stateDir, 'personal.jsonl');
    this.stateFile = path.join(cfg.stateDir, 'personal-state.json');
    this.enabled = cfg.personal;
  }

  private lines(): Line[] {
    try {
      return fs
        .readFileSync(this.file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as Line;
          } catch {
            return null;
          }
        })
        .filter(Boolean) as Line[];
    } catch {
      return [];
    }
  }

  private append(line: Line) {
    fs.appendFileSync(this.file, `${JSON.stringify(line)}\n`);
  }

  /** Every entry, oldest first, with the asked markers folded out. */
  entries(): (PersonalEntry & { asked: boolean })[] {
    const all = this.lines();
    const asked = new Set(all.filter((l): l is AskedMarker => l.kind === 'asked').map((m) => m.ref));
    return all
      .filter((l): l is PersonalEntry => l.kind !== 'asked')
      .map((e) => ({ ...e, asked: asked.has(e.ts) }));
  }

  /**
   * Write one thing down. Returns the entry, or null when personal context is off
   * — and OFF MEANS OFF: someone who disables this is saying don't keep a file on
   * me, so the disabled path records nothing at all rather than quietly recording
   * and merely declining to ask.
   */
  remember(kind: PersonalKind, text: string, due?: string): PersonalEntry | null {
    if (!this.enabled) return null;
    const clean = text.trim();
    if (!clean) return null;
    const entry: PersonalEntry = { ts: new Date().toISOString(), kind, text: clean, ...(due ? { due } : {}) };
    this.append(entry);
    return entry;
  }

  /** Threads worth asking about now: due has passed, and never asked. */
  dueThreads(now = Date.now()): PersonalEntry[] {
    return this.entries().filter(
      (e) => e.kind === 'thread' && !e.asked && e.due && new Date(e.due).getTime() <= now
    );
  }

  markAsked(ts: string) {
    if (!this.enabled) return;
    this.append({ ts: new Date().toISOString(), kind: 'asked', ref: ts });
  }

  private lastBeat(): number {
    try {
      return Number(JSON.parse(fs.readFileSync(this.stateFile, 'utf8')).lastBeatAt) || 0;
    } catch {
      return 0;
    }
  }

  private noteBeat(at: number) {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({ lastBeatAt: at }));
    } catch {
      /* a state dir we cannot write is not worth failing a greeting over */
    }
  }

  /**
   * The one personal beat, or nothing — and MOST DAYS SHOULD BE NOTHING.
   *
   * The check is mechanical precisely so it cannot drift into chattiness. It is
   * only ever called at a moment that is already hers (the boot greeting, or the
   * first turn after a long gap), never mid-work: the whole point of the harness
   * is that she protects your attention, and interrupting a debugging session to
   * ask how your week is going is the opposite of that.
   */
  beat(now = Date.now()): string | null {
    if (!this.enabled) return null;
    // At most one a day, whatever else is true.
    if (now - this.lastBeat() < 24 * 60 * 60_000) return null;

    const due = this.dueThreads(now)[0];
    if (due) {
      this.markAsked(due.ts);
      this.noteBeat(now);
      // Marked asked whether or not he answers — a follow-up he ignored is still
      // a follow-up, and asking it twice is worse than not asking at all.
      return `Something you noted is due a follow-up: "${due.text}". Ask him how it went, in ONE short sentence, as part of your greeting — not as a separate announcement, and not with any preamble about remembering it.`;
    }

    // Nothing to follow up on. A light check-in is allowed only when there is
    // nothing personal on file from the last day AND he is arriving rather than
    // returning mid-task; the caller owns the second half of that.
    const recent = this.entries().filter((e) => now - new Date(e.ts).getTime() < 24 * 60 * 60_000);
    if (recent.length) return null;
    this.noteBeat(now);
    return 'You have nothing on file about how he is doing. You may add ONE short, specific, human line to your greeting — an actual question, not "how are you feeling today". If nothing genuine comes to mind, say nothing: silence is the right default.';
  }

  /**
   * What rides the system prompt. Capped, so a file that grows for years does not
   * grow the prefix with it: the most recent N, plus anything still owed a
   * follow-up however old it is.
   */
  promptBlock(now = Date.now()): string {
    if (!this.enabled) return '';
    const all = this.entries();
    if (!all.length) return '';
    const recent = all.slice(-PROMPT_RECENT);
    const owed = this.dueThreads(now).filter((d) => !recent.some((r) => r.ts === d.ts));
    const show = [...owed, ...recent];
    const line = (e: PersonalEntry) =>
      `- (${e.kind}${e.due ? `, follow up after ${e.due.slice(0, 10)}` : ''}) ${e.text}`;
    return [
      '',
      '',
      'What you know about Danny personally, from earlier conversations:',
      ...show.map(line),
      'Use this the way a colleague would — to follow something up when it is natural, and to not ask a question you already know the answer to. Do not recite it back at him.',
    ].join('\n');
  }
}

/**
 * How she is told to USE the tool, which matters more than the tool.
 *
 * A model given a memory tool will otherwise use it to take minutes — recording
 * every exchange, then reciting them. This says the opposite twice.
 */
export const PERSONAL_PROMPT = [
  'You remember Danny between sessions, not just the work. Use `remember` when he mentions something about himself IN PASSING — a demo on Thursday, a bad night, how he likes to work, who someone is. One item per call.',
  'Never interrogate him to fill it in, never record the work itself (plans and events are already tracked), and never read the file back to him. `recall` is for you, not for reciting.',
  'Kinds: `thread` is something with an outcome you could ask about later, and is the ONLY kind that should carry a `due` date — set one when a follow-up would be welcome. `preference` is how he likes to work. `state` is passing (sleep, travel, a bad week) and is for tone, not for asking about. `fact` is durable and dull.',
  'Ask about his life at most once in a day, only when a turn is already yours to open, and only about something you actually recorded. Most days you should say nothing personal at all, and that is correct.',
].join(' ');
