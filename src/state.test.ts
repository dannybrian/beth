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

test('orphaning does not resurrect or re-close what already finished', () => {
  const s = new PendingStore();
  worker(s, 't1');
  s.workerFinished('t1', 'completed', 10, 'the real summary');
  worker(s, 't2');

  assert.equal(s.orphanWorkers(), 1, 'only the one still running');
  assert.equal(s.allWorkers()[0].summary, 'the real summary', 'a finished worker keeps its own account');
  assert.equal(s.allWorkers()[0].status, 'completed');
});
