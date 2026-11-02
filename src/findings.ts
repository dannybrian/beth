// Findings Danny has read — the digest's other half (docs/findings.md).
//
// The plans hold the findings; this holds only which ones he has SEEN. Same
// argument as pins: that is one person's attention on one machine, not a fact
// about the work, so it lives in the state dir and no plan file learns of it.
// The harness still only reads plans.
//
// ⚠ Computed over the WHOLE index, never the live slice. Findings land in done
// notes, and the plans carrying them are mostly finished by the time anyone
// asks — 305, the plan that prompted this, is `shipped`.
import fs from 'node:fs';
import path from 'node:path';
import type { WorkFinding, WorkItem, WorkStatus } from './workItems.ts';

/** A finding with its plan, as the panel and her tool show it. */
export type FindingRow = WorkFinding & { path: string; plan: string; status: WorkStatus; read: boolean };

export class FindingsRead {
  private file: string;
  private read = new Set<string>();
  private seeded = false;

  constructor(cfg: { stateDir: string }) {
    this.file = path.join(cfg.stateDir, 'findings-read.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw?.read)) for (const id of raw.read) if (typeof id === 'string') this.read.add(id);
      this.seeded = true;
    } catch {
      /* first boot here, or an unreadable file — seed() decides what that means */
    }
  }

  /**
   * First boot marks everything ALREADY marked as read, the same rule as the
   * inbox and the decision queue: adopting the digest must not open with a
   * backlog presented as news. Called once the index has its first read.
   */
  seed(items: WorkItem[]) {
    if (this.seeded) return;
    for (const f of findingsOf(items)) this.read.add(f.id);
    this.seeded = true;
    this.save();
  }

  /** Newest first; within a day, plan by plan in file order. */
  rows(items: WorkItem[], opts: { unreadOnly?: boolean } = {}): FindingRow[] {
    const rows = findingsOf(items)
      .map((f) => ({ ...f, read: this.read.has(f.id) }))
      .filter((f) => !opts.unreadOnly || !f.read);
    return rows.sort((a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path) || a.line - b.line);
  }

  /** Ids no longer in any plan are left alone: a plan can come back. */
  markRead(ids: string[]) {
    for (const id of ids) this.read.add(id);
    this.save();
  }

  markAll(items: WorkItem[]) {
    this.markRead(findingsOf(items).map((f) => f.id));
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ read: [...this.read] }, null, 1));
    } catch {
      /* read state that does not survive a restart beats a harness that will not start */
    }
  }
}

function findingsOf(items: WorkItem[]) {
  return items.flatMap((i) =>
    (i.findings ?? []).map((f) => ({ ...f, path: i.path, plan: i.spoken, status: i.status }))
  );
}
