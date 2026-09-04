// The inbox — hand-offs from other agents and apps, read through the reader seam.
//
// A producer (Memobase's index step, a script, another agent) APPENDS one JSON
// line per hand-off to a file; every running harness reads every file. The
// harness defines the record and never learns the producer: the first one is
// named only by HARNESS_INBOX in the machine .env. See docs/inbox.md for why it
// is a reader and not an API, and for what is set aside.
//
// Two rules hold everything else up:
//   - The producer's file is never written. Not truncated, not rotated, not
//     marked. A hand-off taken or dismissed here is recorded in the STATE DIR
//     (InboxAcks, the pins pattern), because one person's decision about one
//     hand-off on one machine is attention, not a fact about the producer's data.
//   - A bad line is skipped and counted, never fatal. A producer bug that blanked
//     the whole board would hide every other hand-off behind the broken one.
import fs from 'node:fs';
import path from 'node:path';
import type { HarnessConfig } from './config.ts';
import type { WorkItemDraft, WorkReader, WorkStatus } from './workItems.ts';

/** Harness-defined. A producer's superset rides along and is ignored. */
export type InboxRecord = {
  /** Stable, unique within its file. Identity is (file, id). */
  id: string;
  /** ISO timestamp of the hand-off. */
  at: string;
  /** What is being handed off, already polished. Markdown allowed. */
  text: string;
  /** The producer's name — for the row, and for the spoken line. */
  from: string;
  /** A director's name. Absent means everyone. */
  to?: string;
  /** Else the first line of `text`. */
  title?: string;
  /** The producer's source reference. Opaque: shown, never opened. */
  ref?: string;
};

export type InboxAck = { state: 'done' | 'dismissed'; at: string; ref?: string };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/**
 * One file's worth. Pure, so it is tested on strings.
 *
 * ⚠️ A file that does not end in a newline has a writer mid-append on its last
 * line. That line is not malformed — it is not finished — so it is skipped this
 * pass without being counted, and the next read picks it up whole.
 */
export function parseInbox(text: string): { records: InboxRecord[]; malformed: number; partial: boolean } {
  const lines = text.split('\n');
  const partial = lines.length > 0 && lines[lines.length - 1] !== '';
  if (partial) lines.pop();
  const records: InboxRecord[] = [];
  const ids = new Set<string>();
  let malformed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    const id = o && str(o.id);
    const at = o && str(o.at);
    const body = o && str(o.text);
    const from = o && str(o.from);
    // A duplicate id is a producer bug, and keeping the FIRST is the choice that
    // does not let a later, possibly corrupt line replace a hand-off he has
    // already acknowledged under that identity.
    if (!o || !id || !at || !body || !from || ids.has(id)) {
      malformed++;
      continue;
    }
    ids.add(id);
    records.push({ id, at, text: body, from, to: str(o.to), title: str(o.title), ref: str(o.ref) });
  }
  return { records, malformed, partial };
}

/** The synthetic path. Nothing resolves it against the repo — see isInboxPath. */
export const inboxPath = (stem: string, id: string) => `inbox/${stem}/${encodeURIComponent(id)}`;
/** True for an item with no file behind it — every path-based affordance must refuse. */
export const isInboxPath = (p: string) => p.startsWith('inbox/');

/** The row's title: the producer's, else the first line of the text, unmarked. */
export function inboxTitle(r: Pick<InboxRecord, 'title' | 'text'>): string {
  const explicit = r.title?.trim();
  if (explicit) return explicit;
  const first = r.text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6}|>)\s*/, '').replace(/^\[[ xX]\]\s*/, '').trim())
    .find(Boolean);
  const line = (first ?? '').replace(/\*\*|__|`/g, '');
  return line.length > 90 ? `${line.slice(0, 87).trimEnd()}…` : line || '(empty hand-off)';
}

/**
 * Addressing. A name is an addressing protocol, and a queue needs one at both
 * ends: `to` is matched against the director's name, case-insensitively; an
 * UNADDRESSED record is for everyone, because the producer could not say who
 * it was for and hiding it everywhere is the wrong default. One addressed to a
 * director who is not running is shown by nobody — that is the desk's problem
 * when the desk exists, not a reason to guess here.
 */
export function addressedTo(record: Pick<InboxRecord, 'to'>, director: string): boolean {
  if (!record.to) return true;
  const me = director.trim().toLowerCase();
  return Boolean(me) && record.to.trim().toLowerCase() === me;
}

/**
 * Hers, per repo, like pins. Keyed by the item's synthetic path, so an ack and
 * the row it belongs to agree by construction.
 */
export class InboxAcks {
  private file: string;
  private acks: Record<string, InboxAck> = {};

  constructor(cfg: Pick<HarnessConfig, 'stateDir'>) {
    this.file = path.join(cfg.stateDir, 'inbox.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          const a = v as Partial<InboxAck>;
          if ((a?.state === 'done' || a?.state === 'dismissed') && typeof a.at === 'string') {
            this.acks[k] = { state: a.state, at: a.at, ...(typeof a.ref === 'string' ? { ref: a.ref } : {}) };
          }
        }
      }
    } catch {
      /* nothing acknowledged yet, or a file we cannot read — every hand-off is open */
    }
  }

  get(p: string): InboxAck | undefined {
    return this.acks[p];
  }

  /** `null` reopens: an ack he changed his mind about goes away, it is not a third state. */
  set(p: string, ack: Omit<InboxAck, 'at'> | null): InboxAck | undefined {
    if (ack) this.acks[p] = { state: ack.state, at: new Date().toISOString(), ...(ack.ref ? { ref: ack.ref } : {}) };
    else delete this.acks[p];
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.acks, null, 2));
    } catch {
      /* an ack that does not survive a restart beats a harness that will not start */
    }
    return this.acks[p];
  }
}

const statusFor = (ack: InboxAck | undefined): WorkStatus =>
  // Out of the live set once acknowledged, into the group that says what
  // happened to it. Nothing is deleted from the producer's file, so nothing is
  // ever lost — "show all" still has it.
  !ack ? 'inbox' : ack.state === 'done' ? 'shipped' : 'parked';

/** Hand-offs arrive while he is away; see WorkReader.pollMs. */
export const INBOX_POLL_MS = 30_000;

export function createInboxReader(opts: {
  dir: string;
  files: string[];
  /** Read at read time, not captured: a persona switch changes who she is. */
  director: () => string;
  acks: InboxAcks;
  pollMs?: number;
}): WorkReader {
  // Logged when it CHANGES, so a standing bad line is not a line of console per
  // debounce — and so a new one is not lost among the old.
  const reported = new Map<string, number>();

  const sources = (): string[] => {
    const out: string[] = [];
    try {
      for (const e of fs.readdirSync(opts.dir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path.join(opts.dir, e.name));
      }
    } catch {
      /* no drop directory is the ordinary case on a machine with no producers */
    }
    for (const f of opts.files) if (fs.existsSync(f) && !out.includes(f)) out.push(f);
    return out.sort();
  };

  return {
    name: 'inbox',
    pollMs: opts.pollMs ?? INBOX_POLL_MS,

    watchRoots(): string[] {
      const dirs = new Set<string>();
      if (fs.existsSync(opts.dir)) dirs.add(opts.dir);
      for (const f of opts.files) if (fs.existsSync(f)) dirs.add(path.dirname(f));
      return [...dirs];
    },

    read(): WorkItemDraft[] {
      const me = opts.director();
      const items: WorkItemDraft[] = [];
      const stems = new Set<string>();
      for (const file of sources()) {
        let text: string;
        try {
          text = fs.readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        const { records, malformed } = parseInbox(text);
        if ((reported.get(file) ?? 0) !== malformed) {
          reported.set(file, malformed);
          if (malformed) console.warn(`  inbox: ${malformed} malformed line${malformed === 1 ? '' : 's'} skipped in ${file}`);
        }
        // Identity is (file, id). Two files with one basename would collide on
        // the path, so the second is told apart — rare, and better than a row
        // that flips between two hand-offs.
        let stem = path.basename(file, '.jsonl');
        for (let n = 2; stems.has(stem); n++) stem = `${path.basename(file, '.jsonl')}~${n}`;
        stems.add(stem);

        for (const r of records) {
          if (!addressedTo(r, me)) continue;
          const p = inboxPath(stem, r.id);
          const ack = opts.acks.get(p);
          items.push({
            path: p,
            title: inboxTitle(r),
            status: statusFor(ack),
            started: r.at,
            lastTouched: ack?.at ?? r.at,
            tags: [r.from],
            claim: null,
            tasks: [],
            dependsOn: [],
            reader: 'inbox',
            inbox: { from: r.from, text: r.text, at: r.at, ref: r.ref, to: r.to, ack },
          });
        }
      }
      return items;
    },
  };
}
