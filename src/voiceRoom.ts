// The voice ROOM — what every harness on ONE machine shares about speaking.
//
// One beth per repo means three beths on one desk, each electing a speaker tab
// and knowing nothing of the others — so three voices could land at once. The
// browser cannot fix this (three ports are three origins; no shared
// BroadcastChannel, no shared Web Lock), but the harnesses already share a
// directory: `~/.director-harness/`, the same place the credentials live. So
// coordination is files there, and three things live in the room:
//
//   - the talking STICK (`voice.stick`) — held while a harness has published
//     lines a page is still playing, so beths take turns by thought, not by
//     overlap. Taken with an atomic create; a holder heartbeats a short TTL so
//     a dead process frees the stick in seconds rather than never.
//   - the universal MUTE (`voice.mute`) — existence is the whole message.
//     "Everybody, right now", as opposed to the per-harness speech level.
//   - one VOLUME (`voice.volume`) — voices are similar in loudness, so the dial
//     is the machine's, not the tab's.
//
// ⚠️ A broken room (unwritable dir, dead disk) must never block speech: every
// failure here degrades to speaking UNCOORDINATED, because overlap is the old
// behaviour and silence would be a new bug — one whose only symptom is a
// harness that never talks again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type RoomState = { muted: boolean; volume: number };

/**
 * How long a held stick outlives its holder's last heartbeat. Short on purpose:
 * this only covers a DEAD process (a live one refreshes below), and every
 * second here is a second the surviving beths stay needlessly quiet.
 */
const STICK_TTL_MS = 12_000;
const HEARTBEAT_MS = 4_000;
const POLL_MS = 250;

export class VoiceRoom {
  private dir: string;
  private stickFile: string;
  private muteFile: string;
  private volumeFile: string;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private watcher: fs.FSWatcher | null = null;
  /** What the watcher last reported, so our own writes do not echo back. */
  private lastSeen: RoomState | null = null;
  private holding = false;
  private broken = false;
  private closed = false;

  constructor(dir = path.join(os.homedir(), '.director-harness')) {
    this.dir = dir;
    this.stickFile = path.join(dir, 'voice.stick');
    this.muteFile = path.join(dir, 'voice.mute');
    this.volumeFile = path.join(dir, 'voice.volume');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      this.broken = true;
      console.log(`  voice-room: unusable (${e instanceof Error ? e.message : e}) — speaking uncoordinated`);
    }
  }

  // --- the talking stick ------------------------------------------------------

  /**
   * One shot at the stick. True means we hold it (or the room is broken and
   * coordination is off — never block speech on a room that cannot work).
   */
  tryAcquire(): boolean {
    if (this.broken || this.holding) return true;
    try {
      fs.writeFileSync(this.stickFile, this.stamp(), { flag: 'wx' });
      this.holding = true;
      this.startHeartbeat();
      return true;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') {
        this.broken = true;
        console.log(`  voice-room: stick unwritable (${e?.message ?? e}) — speaking uncoordinated`);
        return true;
      }
      // Someone holds it. If they are provably gone, clear the wreck — but do
      // NOT claim it in the same breath: the next round's create may lose to
      // another stealer, and that is the correct outcome, not a retry bug.
      if (this.stickIsStale()) this.stealStale();
      return false;
    }
  }

  /** The stick, however long it takes. Immediate when the room is free. */
  acquire(): Promise<void> {
    if (this.tryAcquire()) return Promise.resolve();
    return new Promise((resolve) => {
      const poll = () => {
        if (this.closed || this.tryAcquire()) return resolve();
        setTimeout(poll, POLL_MS).unref?.();
      };
      setTimeout(poll, POLL_MS).unref?.();
    });
  }

  release() {
    if (!this.holding) return;
    this.holding = false;
    this.stopHeartbeat();
    if (this.broken) return;
    try {
      // Only unlink OUR stick. A heartbeat stalled past the TTL means another
      // harness may have legitimately stolen it — unlinking then would free a
      // stick someone else is speaking on, and two voices would overlap with
      // every appearance of the feature working.
      const held = JSON.parse(fs.readFileSync(this.stickFile, 'utf8'));
      if (held?.pid === process.pid) fs.unlinkSync(this.stickFile);
    } catch {
      /* already gone, or unreadable — either way it is not ours to free */
    }
  }

  private stamp() {
    return JSON.stringify({ pid: process.pid, until: Date.now() + STICK_TTL_MS });
  }

  /**
   * Stale means provably dead: past its TTL, held by a pid that no longer
   * exists, or unparseable. ⚠️ The bar is deliberately high — a wrong "stale"
   * cuts into a LIVE sentence from another beth, which is the inverted bug and
   * looks exactly like coordination working.
   */
  private stickIsStale(): boolean {
    try {
      const held = JSON.parse(fs.readFileSync(this.stickFile, 'utf8'));
      if (typeof held?.pid !== 'number' || typeof held?.until !== 'number') return true;
      if (held.until < Date.now()) return true;
      try {
        process.kill(held.pid, 0);
        return false; // alive
      } catch (err: any) {
        // ESRCH is "no such process". EPERM is alive-but-not-ours: not stale.
        return err?.code === 'ESRCH';
      }
    } catch (e: any) {
      // Gone between EEXIST and here means it was RELEASED, not that it rotted.
      return e?.code !== 'ENOENT';
    }
  }

  /**
   * Clear a stale stick via rename: rename is atomic, so of two harnesses that
   * both diagnosed staleness, exactly one wins the steal — unlink-then-create
   * would let the loser unlink the winner's fresh stick.
   */
  private stealStale() {
    const grave = `${this.stickFile}.stale-${process.pid}`;
    try {
      fs.renameSync(this.stickFile, grave);
      fs.unlinkSync(grave);
    } catch {
      /* the other stealer got there first, which is fine */
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      try {
        const held = JSON.parse(fs.readFileSync(this.stickFile, 'utf8'));
        if (held?.pid !== process.pid) {
          // We stalled past the TTL and were declared dead. The stick is theirs
          // now — rewriting it would put two holders on one stick.
          this.holding = false;
          this.stopHeartbeat();
          return;
        }
        fs.writeFileSync(this.stickFile, this.stamp());
      } catch {
        /* a missed beat is what the TTL is for */
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  // --- mute and volume --------------------------------------------------------

  muted(): boolean {
    try {
      return fs.existsSync(this.muteFile);
    } catch {
      return false;
    }
  }

  setMuted(on: boolean) {
    try {
      if (on) fs.writeFileSync(this.muteFile, '');
      else fs.rmSync(this.muteFile, { force: true });
    } catch {
      /* broken room — the caller's own publish still updates its pages */
    }
    this.markSeen();
  }

  /** 0..1, defaulting to full — garbage in the file must not silence anyone. */
  volume(): number {
    try {
      const v = Number(fs.readFileSync(this.volumeFile, 'utf8'));
      return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
    } catch {
      return 1;
    }
  }

  setVolume(v: number) {
    const clamped = Math.min(1, Math.max(0, Number(v) || 0));
    try {
      fs.writeFileSync(this.volumeFile, String(clamped));
    } catch {
      /* same degradation as setMuted */
    }
    this.markSeen();
  }

  state(): RoomState {
    return { muted: this.muted(), volume: this.volume() };
  }

  /** Our own writes are already known to our owner; only OTHERS should echo. */
  private markSeen() {
    if (this.lastSeen) this.lastSeen = this.state();
  }

  /**
   * Hear the OTHER harnesses: a mute or volume flipped elsewhere arrives as a
   * file change. fs.watch's contract is "something happened", not what — the
   * dir also carries state subdirs and heartbeat churn — so every event
   * re-reads and diffs, which also absorbs platforms that omit filenames.
   */
  watch(cb: (s: RoomState) => void) {
    if (this.broken) return;
    this.lastSeen = this.state();
    try {
      this.watcher = fs.watch(this.dir, () => {
        const now = this.state();
        if (this.lastSeen && now.muted === this.lastSeen.muted && now.volume === this.lastSeen.volume) return;
        this.lastSeen = now;
        cb(now);
      });
      this.watcher.unref?.();
    } catch (e) {
      this.broken = true;
      console.log(`  voice-room: cannot watch (${e instanceof Error ? e.message : e}) — other harnesses' dials won't reach this page live`);
    }
  }

  close() {
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
    this.release();
  }
}
