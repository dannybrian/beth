// ConversationBus — the single ordered flow of everything the UI shows.
// Every plane (session, tools, ask gate, event log) publishes here; the web
// server is currently the only subscriber. Speech (Phase 2) subscribes alongside.
import type { HarnessEvent } from './eventlog.ts';
import type { WorkItem, WorkRef } from './workItems.ts';

export type UsageSnapshot = {
  contextPct: number;
  contextTokens: number;
  contextMax: number;
  turnInput: number;
  turnOutput: number;
  turnCached: number;
  turnCost: number;
  totalCost: number;
  model: string;
};

export type PendingDecision = {
  id: string;
  title: string;
  context: string;
  options?: string[];
  plan?: string;
  urgency: 'when-free' | 'today' | 'blocking-later';
  queuedAt: string;
  resolved?: { answer: string; at: string };
};

export type WorkerRecord = {
  taskId: string;
  description: string;
  agentType?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: string;
  endedAt?: string;
  tokens?: number;
  summary?: string;
};

export type AskQuestion = {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect?: boolean;
};

export type UIMessage =
  | { type: 'hello'; repo: string; mode: string; modeReason: string; model: string }
  // `refs` are what Danny POINTED at for this turn — rendered as chips in the
  // transcript so a turn stays readable next to what he actually typed.
  | { type: 'user'; text: string; refs?: WorkRef[] }
  // `text` is what Danny READS (audio tags stripped); `voiceText` is what he HEARS.
  | { type: 'assistant'; text: string; voiceText?: string }
  | { type: 'say'; kind: string; text: string; voiceText?: string; ref?: string }
  | { type: 'activity'; tool: string; detail: string }
  | { type: 'ask'; id: string; questions: AskQuestion[] }
  | { type: 'ask_resolved'; id: string; answers: Record<string, string> }
  | { type: 'approval'; id: string; tool: string; title: string; detail: string }
  | { type: 'approval_resolved'; id: string; allowed: boolean }
  | { type: 'usage'; usage: UsageSnapshot }
  | { type: 'status'; state: 'idle' | 'thinking' | 'error'; detail?: string; turn?: number }
  | { type: 'pending'; decisions: PendingDecision[]; workers: WorkerRecord[] }
  | { type: 'work'; items: WorkItem[] }
  // Server-owned pointing state. Published when a turn CONSUMES it, so the page
  // drops chips that a spoken turn just used.
  | { type: 'pointing'; refs: WorkRef[] }
  | { type: 'voice'; state: string; detail?: string; status: Record<string, unknown> }
  | { type: 'cleared' }
  | { type: 'model'; model: string }
  | { type: 'event'; event: HarnessEvent };

export class ConversationBus {
  private subscribers = new Set<(m: UIMessage) => void>();
  private history: UIMessage[] = [];
  private lastStatus: UIMessage | null = null;
  private static HISTORY_CAP = 400;

  subscribe(fn: (m: UIMessage) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  publish(m: UIMessage) {
    // Transient state messages don't accumulate in replay — but the CURRENT
    // status still has to reach a browser that connects mid-turn. `work`
    // republishes on every file save, so replaying it would bury the transcript.
    if (m.type === 'status') {
      this.lastStatus = m;
    } else if (m.type !== 'pending' && m.type !== 'work' && m.type !== 'pointing') {
      this.history.push(m);
      if (this.history.length > ConversationBus.HISTORY_CAP) this.history.shift();
    }
    for (const fn of this.subscribers) {
      try {
        fn(m);
      } catch {
        /* a dead subscriber must not break the bus */
      }
    }
  }

  /** Replay for a browser that connects (or reconnects) mid-conversation. */
  replay(): UIMessage[] {
    return this.lastStatus ? [...this.history, this.lastStatus] : this.history;
  }

  /** Drop the transcript so a cleared conversation does not come back on refresh. */
  clear() {
    this.history = [];
    this.lastStatus = null;
  }
}
