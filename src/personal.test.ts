import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonalStore } from './personal.ts';
import type { HarnessConfig } from './config.ts';

const store = (personal = true) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-personal-'));
  return new PersonalStore({ stateDir, personal } as HarnessConfig);
};

const DAY = 24 * 60 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

test('one thing per call, read back oldest first', () => {
  const s = store();
  s.remember('fact', 'Timezone is Mountain.');
  s.remember('preference', 'Commits and pushes are his, not hers.');
  assert.deepEqual(
    s.entries().map((e) => e.kind),
    ['fact', 'preference']
  );
});

test('the file is append-only — nothing is silently rewritten', () => {
  // Same reason as the event log. It is also why "asked" arrives as its own
  // record rather than as an edit to the entry.
  const s = store();
  const a = s.remember('thread', 'Demo Thursday', iso(Date.now() - DAY))!;
  s.markAsked(a.ts);
  s.remember('fact', 'later');
  const raw = fs.readFileSync((s as any).file, 'utf8').trim().split('\n');
  assert.equal(raw.length, 3);
  assert.equal(JSON.parse(raw[0]).text, 'Demo Thursday', 'the original entry is untouched');
});

// --- she may only ask about something she actually knows ---------------------

test('a thread whose due has passed is what generates a question', () => {
  const s = store();
  s.remember('thread', 'Demo for the tulito folks — nervous about the geo pins', iso(Date.now() - DAY));
  const beat = s.beat();
  assert.ok(beat);
  assert.match(beat!, /geo pins/);
});

test('a thread that is NOT yet due is left alone', () => {
  const s = store();
  s.remember('thread', 'Demo next week', iso(Date.now() + 7 * DAY));
  // Something is on file from today, so the open check-in is suppressed too.
  assert.equal(s.beat(), null);
});

test('only `thread` asks — a preference or a state never becomes a question', () => {
  const s = store();
  s.remember('preference', 'Hates being asked how he is', iso(Date.now() - DAY));
  s.remember('state', 'Bad night', iso(Date.now() - DAY));
  assert.deepEqual(s.dueThreads(), []);
});

test('a followed-up thread is never asked twice', () => {
  // Marked asked whether or not he answered: a question he ignored is still a
  // question, and asking it again is worse than never having asked.
  const s = store();
  s.remember('thread', 'Demo Thursday', iso(Date.now() - DAY));
  assert.ok(s.beat());
  const later = Date.now() + 2 * DAY;
  assert.equal(s.dueThreads(later).length, 0);
});

test('at most ONE beat a day, however much is owed', () => {
  const s = store();
  s.remember('thread', 'Demo Thursday', iso(Date.now() - 2 * DAY));
  s.remember('thread', 'The interview', iso(Date.now() - 2 * DAY));
  assert.ok(s.beat());
  assert.equal(s.beat(), null, 'the second owed thread waits for tomorrow');
});

test('nothing on file at all still allows ONE light check-in', () => {
  const s = store();
  const beat = s.beat();
  assert.ok(beat);
  assert.match(beat!, /silence is the right default/i);
});

test('...but not when something personal was recorded in the last day', () => {
  // The value is in the follow-up. A check-in on a day he has already told her
  // something is the form-with-a-face-on-it failure.
  const s = store();
  s.remember('state', 'Slept badly');
  assert.equal(s.beat(), null);
});

// --- off means off ------------------------------------------------------------

test('disabled records NOTHING, rather than recording and staying quiet', () => {
  // Someone who turns this off is saying don't keep a file on me.
  const s = store(false);
  assert.equal(s.remember('fact', 'anything'), null);
  assert.equal(s.beat(), null);
  assert.equal(s.promptBlock(), '');
  assert.deepEqual(s.entries(), []);
  assert.equal(fs.existsSync((s as any).file), false, 'no file is created at all');
});

// --- what rides the prompt ----------------------------------------------------

test('the prompt block is capped, so years of history cannot grow the prefix', () => {
  const s = store();
  for (let i = 0; i < 60; i++) s.remember('fact', `fact ${i}`);
  const block = s.promptBlock();
  assert.match(block, /fact 59/);
  assert.doesNotMatch(block, /fact 30\b/);
});

test('an owed follow-up rides the prompt however old it is', () => {
  // Falling off the recency window is exactly how she would forget the one thing
  // she is supposed to remember.
  const s = store();
  const old = s.remember('thread', 'The tulito demo', iso(Date.now() - 30 * DAY))!;
  fs.writeFileSync(
    (s as any).file,
    `${JSON.stringify({ ...old, ts: iso(Date.now() - 400 * DAY) })}\n`
  );
  for (let i = 0; i < 40; i++) s.remember('fact', `fact ${i}`);
  assert.match(s.promptBlock(), /tulito demo/);
});

test('an empty history contributes nothing to the prompt', () => {
  assert.equal(store().promptBlock(), '');
});

test('a corrupt line is skipped rather than losing the whole file', () => {
  const s = store();
  s.remember('fact', 'good one');
  fs.appendFileSync((s as any).file, 'not json\n');
  s.remember('fact', 'another');
  assert.deepEqual(
    s.entries().map((e) => e.text),
    ['good one', 'another']
  );
});
