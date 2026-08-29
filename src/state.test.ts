import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingStore } from './state.ts';

const worker = (store: PendingStore, taskId: string) =>
  store.workerStarted({ taskId, description: `worker ${taskId}`, agentType: 'general-purpose' });

// The roster answers "is anything running" for the panel AND for the activity
// dot, so a worker stuck in it makes both lie about the whole session — which is
// what Danny saw: Beth reporting nothing in flight next to a panel showing two.

test('a worker leaves the roster when it reports back', () => {
  const s = new PendingStore();
  worker(s, 't1');
  s.workerFinished('t1', 'completed', 1200, 'done');
  assert.deepEqual(s.runningWorkers(), []);
});

test('a worker that never reports can be closed by hand', () => {
  const s = new PendingStore();
  worker(s, 't1');
  const w = s.closeWorker('t1', 'died without a notification');
  assert.equal(w?.status, 'stopped');
  assert.equal(w?.summary, 'died without a notification');
  assert.deepEqual(s.runningWorkers(), []);
});

test('closing an unknown or already-closed worker is a no-op, not a lie', () => {
  const s = new PendingStore();
  worker(s, 't1');
  s.closeWorker('t1');
  assert.equal(s.closeWorker('t1'), undefined, 'twice is not two workers');
  assert.equal(s.closeWorker('never-existed'), undefined);
});

// The bug this fixes. `/clear` deliberately keeps the DECISIONS — a question is
// durable — but a worker is a task inside the SDK session, and clearing replaces
// that session. Its notification is never coming.
test('clearing the conversation orphans the workers but keeps the questions', () => {
  const s = new PendingStore();
  worker(s, 't1');
  worker(s, 't2');
  s.queueDecision({ title: 'Ship it?', context: 'c', urgency: 'today' } as never);

  assert.equal(s.orphanWorkers(), 2, 'both were running and both are now gone');
  assert.deepEqual(s.runningWorkers(), []);
  assert.equal(s.openDecisions().length, 1, 'losing a queued decision to /clear would be a nasty surprise');
  assert.match(s.allWorkers()[0].summary ?? '', /cleared/i, 'and the roster says what became of them');
});

// Reconciliation against the SDK's level signal. Both wrong answers are quiet:
// too eager and a worker dies seconds after starting (the SDK leaves level/edge
// ordering unspecified, so a start-adjacent level may not carry the new task);
// too timid and the roster goes back to lying until Danny dismisses by hand.

test('a worker absent from the live set is closed once past the grace window', () => {
  const s = new PendingStore();
  const w = worker(s, 't1');
  const born = Date.parse(w.startedAt);

  // Inside the grace window nothing happens, however absent the id is.
  assert.deepEqual(s.reconcileWorkers(new Set(), born + 1_000), []);
  assert.equal(s.runningWorkers().length, 1, 'a just-started worker is not killed by a stale level');

  const closed = s.reconcileWorkers(new Set(), born + 60_000);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].status, 'stopped');
  assert.match(closed[0].summary ?? '', /without a notification/, 'the roster says what became of it');
  assert.deepEqual(s.runningWorkers(), []);
});

test('a worker present in the live set stays, whatever its age', () => {
  const s = new PendingStore();
  const born = Date.parse(worker(s, 't1').startedAt);
  assert.deepEqual(s.reconcileWorkers(new Set(['t1']), born + 3_600_000), []);
  assert.equal(s.runningWorkers().length, 1);
});

test('ids the roster does not know are ignored, not adopted', () => {
  const s = new PendingStore();
  const born = Date.parse(worker(s, 't1').startedAt);
  s.reconcileWorkers(new Set(['t1', 'stranger']), born + 60_000);
  assert.equal(s.allWorkers().length, 1, 'additions come from task_started, the direction that is not broken');
});

test('a late notification still upgrades a reconciled worker with the truth', () => {
  const s = new PendingStore();
  const born = Date.parse(worker(s, 't1').startedAt);
  s.reconcileWorkers(new Set(), born + 60_000);

  // The real bookend arrives after all — the SDK's ordering caveat in the
  // other direction. The record it finds must take the genuine outcome.
  const w = s.workerFinished('t1', 'completed', 4200, 'the real summary');
  assert.equal(w?.status, 'completed');
  assert.equal(w?.tokens, 4200);
  assert.equal(w?.summary, 'the real summary');
});

test('reconciling never touches what already finished', () => {
  const s = new PendingStore();
  const born = Date.parse(worker(s, 't1').startedAt);
  s.workerFinished('t1', 'failed', 7, 'its own account');
  assert.deepEqual(s.reconcileWorkers(new Set(), born + 60_000), []);
  assert.equal(s.allWorkers()[0].summary, 'its own account');
});

test('orphaning does not resurrect or re-close what already finished', () => {
  const s = new PendingStore();
  worker(s, 't1');
  s.workerFinished('t1', 'completed', 10, 'the real summary');
  worker(s, 't2');

  assert.equal(s.orphanWorkers(), 1, 'only the one still running');
  assert.equal(s.allWorkers()[0].summary, 'the real summary', 'a finished worker keeps its own account');
  assert.equal(s.allWorkers()[0].status, 'completed');
});
