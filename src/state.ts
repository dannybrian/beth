// Live orchestrator state: the Ask-Danny queue and the worker roster.
// This is the LIVE copy — the durable copy stays in plan files, synced by the
// director at wrap points exactly as it does from a terminal.
import type { PendingDecision, WorkerRecord } from './bus.ts';

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export class PendingStore {
  private decisions: PendingDecision[] = [];
  private workers: WorkerRecord[] = [];

  queueDecision(d: Omit<PendingDecision, 'id' | 'queuedAt'>): PendingDecision {
    const rec: PendingDecision = { ...d, id: nextId('dec'), queuedAt: new Date().toISOString() };
    this.decisions.push(rec);
    return rec;
  }

  resolveDecision(id: string, answer: string): PendingDecision | undefined {
    const d = this.decisions.find((x) => x.id === id);
    if (d) d.resolved = { answer, at: new Date().toISOString() };
    return d;
  }

  workerStarted(w: Omit<WorkerRecord, 'status' | 'startedAt'>): WorkerRecord {
    const rec: WorkerRecord = { ...w, status: 'running', startedAt: new Date().toISOString() };
    this.workers.push(rec);
    return rec;
  }

  workerFinished(taskId: string, status: WorkerRecord['status'], tokens?: number, summary?: string) {
    const w = this.workers.find((x) => x.taskId === taskId);
    if (!w) return undefined;
    w.status = status;
    w.endedAt = new Date().toISOString();
    w.tokens = tokens;
    w.summary = summary;
    return w;
  }

  /** Unresolved decisions, oldest first — what "what's pending?" answers from. */
  openDecisions(): PendingDecision[] {
    return this.decisions.filter((d) => !d.resolved);
  }

  runningWorkers(): WorkerRecord[] {
    return this.workers.filter((w) => w.status === 'running');
  }

  allDecisions(): PendingDecision[] {
    return this.decisions;
  }

  allWorkers(): WorkerRecord[] {
    return this.workers;
  }
}
