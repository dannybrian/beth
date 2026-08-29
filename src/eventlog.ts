// Append-only event log at <repo>/.claude/events.jsonl.
// The harness writes its own events and TAILS the file so work done by terminal
// sessions (via the plans hooks) surfaces here too. Plan files stay the durable truth.
import fs from 'node:fs';
import path from 'node:path';

export type EventKind =
  | 'say'
  | 'show'
  | 'ask'
  | 'answer'
  | 'decision_queued'
  | 'decision_resolved'
  | 'worker_started'
  | 'worker_done'
  | 'commit'
  | 'status_change'
  | 'ship';

export type HarnessEvent = {
  ts: string;
  source: 'harness' | 'terminal' | 'hook';
  session: string;
  kind: EventKind;
  text: string;
  ref?: string;
};

export class EventLog {
  private offset = 0;
  private watcher?: fs.FSWatcher;
  private listeners: ((e: HarnessEvent) => void)[] = [];

  private file: string;

  constructor(file: string) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, '');
    this.offset = fs.statSync(file).size;
  }

  onEvent(fn: (e: HarnessEvent) => void) {
    this.listeners.push(fn);
  }

  append(e: Omit<HarnessEvent, 'ts'> & { ts?: string }): HarnessEvent {
    const full: HarnessEvent = { ts: new Date().toISOString(), ...e };
    const line = JSON.stringify(full) + '\n';
    fs.appendFileSync(this.file, line);
    // Claim these bytes so the tail watcher doesn't re-emit our own write.
    this.offset = fs.statSync(this.file).size;
    this.emit(full);
    return full;
  }

  /** Last n events, oldest first. */
  recent(n = 50): HarnessEvent[] {
    const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean);
    return lines
      .slice(-n)
      .map((l) => {
        try {
          return JSON.parse(l) as HarnessEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is HarnessEvent => e !== null);
  }

  /** Watch for appends made by anyone else (terminal sessions, hooks). */
  startTail() {
    this.watcher = fs.watch(this.file, () => {
      let size: number;
      try {
        size = fs.statSync(this.file).size;
      } catch {
        return;
      }
      if (size <= this.offset) {
        // Truncated or rotated — resync without replaying the whole file.
        if (size < this.offset) this.offset = size;
        return;
      }
      const fd = fs.openSync(this.file, 'r');
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      fs.closeSync(fd);
      this.offset = size;
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.emit(JSON.parse(line) as HarnessEvent);
        } catch {
          /* partial line — next append completes it */
        }
      }
    });
  }

  stop() {
    this.watcher?.close();
  }

  private emit(e: HarnessEvent) {
    for (const fn of this.listeners) fn(e);
  }
}
