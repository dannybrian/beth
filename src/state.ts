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

  /**
   * Stop tracking a worker that is no longer running.
   *
   * A worker only ever left `running` on a `task_notification`, so anything that
   * stops one from arriving — the task dying, an interrupt, the session being
   * replaced — left it in the roster forever. The panel then shows work in flight
   * that is not, the activity dot stays lit because something is "running", and
   * the one surface that is supposed to answer "is anything happening" answers
   * wrong. Nothing reconciled it because nothing could: the notification is the
   * only signal, and it is not coming.
   */
  closeWorker(taskId: string, note?: string): WorkerRecord | undefined {
    const w = this.workers.find((x) => x.taskId === taskId && x.status === 'running');
    if (!w) return undefined;
    w.status = 'stopped';
    w.endedAt = new Date().toISOString();
    w.summary = note ?? w.summary;
    return w;
  }

  /**
   * Every running worker belonged to a session that no longer exists.
   *
   * Called when the conversation is cleared. The queued DECISIONS survive that on
   * purpose — a question is durable, and losing one because you cleared the chat
   * would be a nasty surprise — but a worker is a task inside the SDK session, and
   * when that session is replaced its tasks are gone whatever the roster says.
   */
  orphanWorkers(note = 'conversation cleared — the session it ran in is gone'): number {
    const live = this.workers.filter((w) => w.status === 'running');
    for (const w of live) {
      w.status = 'stopped';
      w.endedAt = new Date().toISOString();
      w.summary = note;
    }
    return live.length;
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
