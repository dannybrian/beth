// The machine's shared voice room. Every case here is a failure that would be
// invisible in use: a stick nobody can break looks like a beth who went quiet
// for no reason, a wrong steal cuts into a LIVE sentence from another harness,
// and a broken room that blocked speech would silence her with no error
// anywhere. Two rooms on one directory stand in for two harnesses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { VoiceRoom } from './voiceRoom.ts';

const roomDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-room-'));

/** Poll for a condition — same rule as the watcher tests: never a fixed sleep. */
async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition never held');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('the stick is exclusive, and release hands it on', () => {
  const dir = roomDir();
  const a = new VoiceRoom(dir);
  const b = new VoiceRoom(dir);
  assert.equal(a.tryAcquire(), true);
  assert.equal(b.tryAcquire(), false, 'two beths must not both hold the stick');
  a.release();
  assert.equal(b.tryAcquire(), true);
  a.close();
  b.close();
});

test('acquire() waits its turn and resolves when the holder releases', async () => {
  const dir = roomDir();
  const a = new VoiceRoom(dir);
  const b = new VoiceRoom(dir);
  assert.equal(a.tryAcquire(), true);
  let got = false;
  const pending = b.acquire().then(() => (got = true));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(got, false, 'the stick must not double-grant while held');
  a.release();
  await pending;
  assert.equal(got, true);
  a.close();
  b.close();
});

test('a stick past its TTL is stolen rather than waited on', () => {
  const dir = roomDir();
  // A live pid (our own) but an expired stamp — the holder stopped heartbeating.
  fs.writeFileSync(path.join(dir, 'voice.stick'), JSON.stringify({ pid: process.pid, until: Date.now() - 1000 }));
  const b = new VoiceRoom(dir);
  // First shot clears the wreck, the next claims it — deliberately two steps,
  // so two stealers race the CREATE (atomic) instead of unlinking each other.
  b.tryAcquire();
  assert.equal(b.tryAcquire(), true);
  b.close();
});

test('a stick held by a dead process is stolen even inside its TTL', () => {
  const dir = roomDir();
  // A pid that provably ran and provably exited.
  const dead = spawnSync('true').pid!;
  fs.writeFileSync(path.join(dir, 'voice.stick'), JSON.stringify({ pid: dead, until: Date.now() + 60_000 }));
  const b = new VoiceRoom(dir);
  b.tryAcquire();
  assert.equal(b.tryAcquire(), true);
  b.close();
});

test('a live in-TTL stick is NOT stolen — the wrong steal cuts a live sentence', () => {
  const dir = roomDir();
  fs.writeFileSync(path.join(dir, 'voice.stick'), JSON.stringify({ pid: process.pid, until: Date.now() + 60_000 }));
  const b = new VoiceRoom(dir);
  assert.equal(b.tryAcquire(), false);
  assert.equal(b.tryAcquire(), false);
  b.close();
});

test('garbage in the stick file reads as stale — never as a lock nobody can break', () => {
  const dir = roomDir();
  fs.writeFileSync(path.join(dir, 'voice.stick'), 'not json at all');
  const b = new VoiceRoom(dir);
  b.tryAcquire();
  assert.equal(b.tryAcquire(), true);
  b.close();
});

test('release only unlinks its OWN stick', () => {
  const dir = roomDir();
  const a = new VoiceRoom(dir);
  assert.equal(a.tryAcquire(), true);
  // Simulate a legitimate steal after a stalled heartbeat: the file is theirs now.
  fs.writeFileSync(path.join(dir, 'voice.stick'), JSON.stringify({ pid: 1, until: Date.now() + 60_000 }));
  a.release();
  assert.equal(fs.existsSync(path.join(dir, 'voice.stick')), true, 'someone else is speaking on that stick');
  a.close();
});

test('mute and volume are shared: one room writes, the other reads', () => {
  const dir = roomDir();
  const a = new VoiceRoom(dir);
  const b = new VoiceRoom(dir);
  assert.deepEqual(b.state(), { muted: false, volume: 1 });
  a.setMuted(true);
  a.setVolume(0.4);
  assert.deepEqual(b.state(), { muted: true, volume: 0.4 });
  a.setMuted(false);
  assert.equal(b.muted(), false);
  a.close();
  b.close();
});

test('volume survives garbage as the default, and clamps what it stores', () => {
  const dir = roomDir();
  const a = new VoiceRoom(dir);
  fs.writeFileSync(path.join(dir, 'voice.volume'), 'eleven');
  assert.equal(a.volume(), 1, 'garbage must not silence anyone');
  a.setVolume(3.7);
  assert.equal(a.volume(), 1);
  a.setVolume(-2);
  assert.equal(a.volume(), 0);
  a.close();
});

test('watch() hears the OTHER room and stays silent for its own writes', async () => {
  const dir = roomDir();
  const a = new VoiceRoom(dir);
  const b = new VoiceRoom(dir);
  const heardByA: unknown[] = [];
  const heardByB: unknown[] = [];
  a.watch((s) => heardByA.push(s));
  b.watch((s) => heardByB.push(s));
  // macOS arms fs.watch asynchronously, so a write landing in the same tick
  // can precede the watcher. Rewriting until heard is the poll-not-sleep rule
  // applied to the ARMING latency; the diff keeps the callback to one firing.
  a.setMuted(true);
  await until(() => {
    if (heardByB.length) return true;
    a.setMuted(true);
    return false;
  });
  assert.deepEqual(heardByB[0], { muted: true, volume: 1 });
  // A's own write must not echo back — its owner already published it, and an
  // echo would publish the same state twice to every tab.
  assert.equal(heardByA.length, 0);
  a.close();
  b.close();
});

test('a broken room never blocks speech', () => {
  // A directory that cannot exist: a path under a regular file.
  const file = path.join(roomDir(), 'not-a-dir');
  fs.writeFileSync(file, '');
  const r = new VoiceRoom(path.join(file, 'room'));
  assert.equal(r.tryAcquire(), true, 'uncoordinated overlap is the old behaviour; silence would be a new bug');
  assert.equal(r.muted(), false);
  assert.doesNotThrow(() => r.setMuted(true));
  assert.doesNotThrow(() => r.setVolume(0.5));
  assert.doesNotThrow(() => r.release());
  r.close();
});

// --- the dial has to correct itself -----------------------------------------
//
// Danny, after a night idle: "the harnesses still showed muted, but speech
// happened anyway until I remuted." A dead fs.watch fails silently — the page
// keeps rendering whatever it last heard, and the button then does the opposite
// of what it shows. The poll is what makes the dial converge on the truth.

test('a change reaches the callback even with the watcher dead', async () => {
  const dir = roomDir();
  const a = new VoiceRoom(dir);
  const seen: boolean[] = [];
  a.watch((s) => seen.push(s.muted), 40);

  // Exactly the macOS-after-sleep case: the handle is closed, so no fs event
  // will EVER arrive again, and nothing anywhere reports that.
  (a as any).watcher?.close();
  (a as any).watcher = null;

  const other = new VoiceRoom(dir);
  other.setMuted(true);
  await new Promise((r) => setTimeout(r, 160));
  assert.deepEqual(seen, [true], 'the poll noticed what the watcher could not');

  other.setMuted(false);
  await new Promise((r) => setTimeout(r, 160));
  assert.deepEqual(seen, [true, false], 'and keeps noticing');

  a.close();
  other.close();
});

test('the poll does not echo a state that did not change', async () => {
  const dir = roomDir();
  const a = new VoiceRoom(dir);
  const seen: boolean[] = [];
  a.watch((s) => seen.push(s.muted), 30);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(seen, [], 'five ticks, nothing changed, nothing published');
  a.close();
});

test('close stops the poll', async () => {
  const dir = roomDir();
  const a = new VoiceRoom(dir);
  const seen: boolean[] = [];
  a.watch((s) => seen.push(s.muted), 30);
  a.close();
  const other = new VoiceRoom(dir);
  other.setMuted(true);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(seen, [], 'a closed room is not still watching');
  other.close();
});
