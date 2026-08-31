// The credit meter — counting usage credits down from a number Danny sets,
// because nothing can read the truth: no SDK field, no CLI surface, and no API
// endpoint exposes a consumer account's credit balance (verified 2026-08-30;
// the balance renders only in claude.ai's Settings UI). So this is the same
// honesty contract as the TTS and STT bills, applied to the biggest number in
// the house: exact about what it metered, printed assumptions about the rest.
//
// The assumptions, and they matter more here than anywhere:
//   - ARMED only while a plan window reports exhaustion. Usage credits drain
//     only after the subscription's own limits are spent, and no API says
//     which turns drew credits — so turns are counted when, at completion, any
//     window sits at 100%. Danny chose this over metering all spend.
//   - LIST PRICE. total_cost_usd is the SDK's client-side estimate from a
//     bundled price table, not billing data.
//   - THIS MACHINE ONLY. Every beth appends to one machine-wide ledger (the
//     voice-room pattern — one account per Mac), but claude.ai chats and
//     terminal sessions draw the same balance invisibly.
//
// The ledger is JSONL, one file per billing cycle (`credits-<cycle-start>.jsonl`
// in ~/.director-harness). Per-cycle files instead of one pruned file because
// three harnesses append concurrently: O_APPEND keeps small appends atomic,
// while a prune-rewrite could eat a neighbour's append mid-flight. Old cycles
// are unlinked (safe cross-process); the previous cycle is kept for questions
// asked the day after a reset.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Clamp a configured reset day into a real date in the given month. */
const clampedDate = (year: number, month: number, day: number) => {
  const last = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, last));
};

/** The current billing cycle's first instant: the latest reset at or before now. */
export function cycleStart(resetDay: number, now: Date): Date {
  const thisMonth = clampedDate(now.getFullYear(), now.getMonth(), resetDay);
  if (thisMonth <= now) return thisMonth;
  return clampedDate(now.getFullYear(), now.getMonth() - 1, resetDay);
}

/** When the countdown refills. */
export function nextReset(resetDay: number, now: Date): Date {
  const start = cycleStart(resetDay, now);
  return clampedDate(start.getFullYear(), start.getMonth() + 1, resetDay);
}

/**
 * Whether any plan window reports exhaustion, read from the same defensively
 * held shape the stats panel renders. >= 100 on ANY window arms the meter —
 * a model-scoped window can exhaust while the turn ran another model, which
 * overcounts slightly; the printed assumption covers it rather than a guess
 * at binding rules no document states.
 */
export function anyWindowExhausted(u: Record<string, unknown> | null): boolean {
  if (!u || !u.rate_limits_available) return false;
  const lim = (u.rate_limits ?? {}) as Record<string, any>;
  const windows = [
    lim.five_hour,
    lim.seven_day,
    lim.seven_day_opus,
    lim.seven_day_sonnet,
    ...(Array.isArray(lim.model_scoped) ? lim.model_scoped : []),
  ];
  return windows.some((w) => w && typeof w.utilization === 'number' && w.utilization >= 100);
}

const key = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export class CreditLedger {
  private dir: string;
  private resetDay: number;

  constructor(dir: string, resetDay: number) {
    this.dir = dir;
    this.resetDay = resetDay;
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.sweep();
    } catch {
      /* an unwritable dir degrades to a meter that reads zero — the panel's
         "nothing metered" is honest either way */
    }
  }

  private file(now: Date) {
    return path.join(this.dir, `credits-${key(cycleStart(this.resetDay, now))}.jsonl`);
  }

  /** One turn's estimated draw. Appends are atomic at this size (O_APPEND). */
  add(usd: number, repo: string, now = new Date()) {
    if (!(usd > 0)) return;
    try {
      fs.appendFileSync(this.file(now), `${JSON.stringify({ t: now.toISOString(), usd, repo })}\n`);
    } catch {
      /* same degradation as the constructor */
    }
  }

  /** Everything metered this cycle, across every beth on the machine. */
  spentUsd(now = new Date()): number {
    try {
      let sum = 0;
      for (const line of fs.readFileSync(this.file(now), 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const v = Number(JSON.parse(line)?.usd);
          if (Number.isFinite(v) && v > 0) sum += v;
        } catch {
          /* a torn or corrupt line loses one turn, never the ledger */
        }
      }
      return sum;
    } catch {
      return 0;
    }
  }

  /** Unlink cycles older than the previous one. Unlink is safe cross-process. */
  private sweep(now = new Date()) {
    const start = cycleStart(this.resetDay, now);
    const keep = new Set([
      key(start),
      key(cycleStart(this.resetDay, new Date(start.getTime() - 86_400_000))),
    ]);
    for (const f of fs.readdirSync(this.dir)) {
      const m = /^credits-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (m && !keep.has(m[1])) fs.rmSync(path.join(this.dir, f), { force: true });
    }
  }
}

export class CreditMeter {
  private ledger: CreditLedger;
  private monthlyUsd: number;
  private resetDay: number;
  private repo: string;
  private exhausted: () => Promise<boolean>;
  /**
   * The exhaustion verdict is CACHED: the check is an SDK round-trip, and a
   * turn every thirty seconds does not need one each. The cost of staleness is
   * a turn or two escaping the count right at the boundary, which the printed
   * assumptions already own.
   */
  private verdict = false;
  private verdictAt = 0;
  private checkMs: number;

  constructor(opts: {
    monthlyUsd: number;
    resetDay: number;
    repo: string;
    /** "Is any plan window at 100% right now" — the owner supplies the read. */
    exhausted: () => Promise<boolean>;
    dir?: string;
    checkMs?: number;
  }) {
    this.monthlyUsd = opts.monthlyUsd;
    this.resetDay = opts.resetDay;
    this.repo = opts.repo;
    this.exhausted = opts.exhausted;
    this.checkMs = opts.checkMs ?? 60_000;
    this.ledger = new CreditLedger(opts.dir ?? path.join(os.homedir(), '.director-harness'), opts.resetDay);
  }

  /** A turn finished at this estimated cost. Counted only while armed. */
  async noteTurn(usd: number) {
    if (!this.monthlyUsd || !(usd > 0)) return;
    if (Date.now() - this.verdictAt > this.checkMs) {
      this.verdictAt = Date.now();
      this.verdict = await this.exhausted().catch(() => false);
    }
    if (this.verdict) this.ledger.add(usd, this.repo);
  }

  state(now = new Date()) {
    if (!this.monthlyUsd) return { available: false as const };
    const spentUsd = this.ledger.spentUsd(now);
    return {
      available: true as const,
      monthlyUsd: this.monthlyUsd,
      spentUsd,
      remainingUsd: this.monthlyUsd - spentUsd,
      resetsAt: nextReset(this.resetDay, now).toISOString(),
      /** Whether the LAST check saw an exhausted window — the panel says which
          mode the meter is in, so a zero reads as "not drawing" rather than
          "not working". */
      armed: this.verdict,
    };
  }
}
