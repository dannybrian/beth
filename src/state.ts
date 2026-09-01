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

  /**
   * The model a delegation ASKED for, held until its worker announces itself.
   *
   * Nothing in the SDK's task messages carries a model — checked against
   * `sdk.d.ts` on 2026-08-31, and it is absent from all five: `task_started`,
   * `task_progress`, `task_notification`, `task_updated`'s patch, and the
   * `background_tasks_changed` level, which is ids only. The one place it exists
   * is the TOOL CALL that started the worker, so the correlation is by
   * `tool_use_id`, which `task_started` carries back.
   *
   * ⚠️ It is what the call named and nothing else. A call that omits `model`
   * leaves the worker without one, and the roster says nothing rather than
   * repeating the session's: a subagent inherits from its own definition, so the
   * session's answer would be confidently wrong exactly where it matters most —
   * a sonnet worker labelled opus, on the panel you check to see what a delegation
   * is costing.
   */
  private taskModels = new Map<string, string>();

  noteTaskModel(toolUseId: string, model: string) {
    if (!toolUseId || !model) return;
    // A call whose worker never starts would otherwise sit here for the life of
    // the process. Oldest out; this is a correlation window, not a record.
    if (this.taskModels.size >= 50) this.taskModels.delete(this.taskModels.keys().next().value as string);
    this.taskModels.set(toolUseId, model);
  }

  workerStarted(w: Omit<WorkerRecord, 'status' | 'startedAt'>, toolUseId?: string): WorkerRecord {
    const model = w.model ?? (toolUseId ? this.taskModels.get(toolUseId) : undefined);
    if (toolUseId) this.taskModels.delete(toolUseId);
    const rec: WorkerRecord = {
      ...w,
      ...(model ? { model } : {}),
      status: 'running',
      startedAt: new Date().toISOString(),
    };
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
   * wrong. Nothing reconciled it because nothing could: the notification was the
   * only signal. No longer true — see reconcileWorkers below — but the manual
   * close stays: it is the escape hatch for whatever the level signal misses,
   * and for a CLI old enough not to emit one.
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
   * Reconcile the roster against the SDK's own list of live tasks.
   *
   * The doc above closeWorker says nothing could reconcile a missed
   * `task_notification`. That stopped being true (noticed 2026-08-28): the SDK
   * now emits `background_tasks_changed`, the full set of live tasks on every
   * membership change — a LEVEL, exactly so a missed edge cannot wedge a stale
   * running indicator. Any running worker absent from the level is done or
   * dead, whatever bookend failed to arrive.
   *
   * ⚠️ The grace window is load-bearing: the SDK leaves ordering between the
   * level and the edges UNSPECIFIED, so a level emitted around a task's start
   * may reach us after `task_started` yet without the new task in it. Closing
   * on that would kill a worker seconds after it was born — the inverted bug,
   * and it would look exactly like the feature working. Ids the roster does
   * not know are ignored for the same reason; additions keep coming from
   * `task_started`, which is not the broken direction.
   *
   * A late `task_notification` for a worker closed here still lands: it finds
   * the record by id and upgrades it with the real status and tokens.
   */
  reconcileWorkers(liveIds: Set<string>, now = Date.now(), graceMs = 10_000): WorkerRecord[] {
    const closed: WorkerRecord[] = [];
    for (const w of this.workers) {
      if (w.status !== 'running' || liveIds.has(w.taskId)) continue;
      if (now - Date.parse(w.startedAt) < graceMs) continue;
      w.status = 'stopped';
      w.endedAt = new Date(now).toISOString();
      w.summary = 'ended without a notification — reconciled from the live task list';
      closed.push(w);
    }
    return closed;
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
