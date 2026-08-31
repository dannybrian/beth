// ConversationBus — the single ordered flow of everything the UI shows.
// Every plane (session, tools, ask gate, event log) publishes here; the web
// server is currently the only subscriber. Speech (Phase 2) subscribes alongside.
import type { HarnessEvent } from './eventlog.ts';
import type { WorkItem, WorkRef } from './workItems.ts';
import type { TextLink } from './links.ts';
import type { TextSpan } from './markdown.ts';
import type { TestState } from './testRunner.ts';

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
  // `mode` is the director ROLE (shadow/director); `permissionMode` is how tool
  // permissions resolve; `director` is what to call her on this page.
  | {
      type: 'hello';
      repo: string;
      mode: string;
      modeReason: string;
      model: string;
      director: string;
      permissionMode: string;
      speechLevel: string;
      /** Chosen reasoning effort; '' is the model's own default. */
      effort: string;
      /** This repo has a github.com origin, so a plan can be opened there. */
      repoOnWeb: boolean;
      /** Every director on this machine, and which one is in force ('' = the repo's own). */
      personas: { slug: string; name: string }[];
      persona: string;
      // The settle window, served to the page because that is where it now runs.
      settleMs: number;
      // Project nouns to bias the recogniser toward, and how hard. Empty when
      // biasing is off — see keyterms.ts.
      keyterms: string[];
      keytermBoost: number;
      /** Which ear this harness offers: the browser recogniser, or Scribe. */
      ear: 'browser' | 'scribe';
      // Which connection this is, so a page can claim the mouth when it is the
      // one you are looking at. See the speaker election in server.ts.
      streamId: number;
    }
  // `refs` are what Danny POINTED at for this turn — rendered as chips in the
  // transcript so a turn stays readable next to what he actually typed.
  | { type: 'user'; text: string; refs?: WorkRef[] }
  // `text` is what Danny READS (audio tags and markdown markers stripped);
  // `voiceText` is the raw form the speech path re-derives from. `links` and
  // `spans` are both offset overlays on `text` — file references and the
  // formatting her markdown carried. Render hints for the page only; the voice
  // path never sees either, which is the point: one canonical string, and
  // overlays that cannot disagree with it.
  | { type: 'assistant'; text: string; voiceText?: string; links?: TextLink[]; spans?: TextSpan[] }
  | {
      type: 'say';
      kind: string;
      text: string;
      voiceText?: string;
      ref?: string;
      links?: TextLink[];
      spans?: TextSpan[];
      refLink?: TextLink;
    }
  // `summary` is the glanceable line (activity.ts); `detail` is the raw input,
  // kept so the page can hang it off a title — the summary is lossy on purpose.
  | { type: 'activity'; tool: string; detail: string; summary?: string }
  | { type: 'ask'; id: string; questions: AskQuestion[] }
  | { type: 'ask_resolved'; id: string; answers: Record<string, string> }
  // `canAlways` is false when the SDK offered no rule that would cover this call
  // again — the card must not then show a button that quietly does nothing.
  | { type: 'approval'; id: string; tool: string; title: string; detail: string; canAlways?: boolean }
  | { type: 'approval_resolved'; id: string; allowed: boolean; always?: boolean }
  | { type: 'usage'; usage: UsageSnapshot }
  | { type: 'status'; state: 'idle' | 'thinking' | 'error'; detail?: string; turn?: number }
  | { type: 'pending'; decisions: PendingDecision[]; workers: WorkerRecord[] }
  // `items` is the in-flight slice only; `total` is the whole corpus, so the
  // panel can say "69 of 571" rather than implying 69 is all there is.
  // `pinned` is Danny's own shelf, resolved server-side because a pinned plan is
  // often NOT in `items` — parked, shipped, an idea. See pins.ts.
  | { type: 'work'; items: WorkItem[]; total: number; pinned: WorkItem[] }
  // Server-owned pointing state. Published when a turn CONSUMES it, so the page
  // drops chips that a spoken turn just used.
  | { type: 'pointing'; refs: WorkRef[] }
  | { type: 'voice'; state: string; detail?: string; status: Record<string, unknown> }
  // A line is ready to be SPOKEN, and here is where to fetch the audio. Carries
  // no words: the transcript already has them, and shipping them twice invites
  // the page to render a copy. Never replayed — see publish().
  | { type: 'speak'; id: string; chars: number }
  /**
   * The Scribe ear (earHost.ts). `owner` is the SSE stream id of the tab whose
   * mic is armed — partials render only where the mic is, and a steal tells
   * the tab that lost it. Not replayed: a partial is a moment, not history.
   */
  | { type: 'ear'; state: 'live' | 'partial' | 'commit' | 'degraded' | 'off'; owner: number; text?: string; detail?: string }
  /**
   * Something she put on the SCREEN — the visual half of `say`. `image` is a
   * figure for the transcript (the path is served by /api/image, which
   * re-proves it); `pop` asks the page to open it large NOW. A `surface` show
   * is nothing but attention — open one of the page's own surfaces. The pop
   * half follows the speaker election in server.ts: "look at this" belongs on
   * the tab Danny is looking at, not on every monitor.
   */
  | { type: 'show'; image?: { path: string; caption?: string }; surface?: 'pending'; pop?: boolean }
  /**
   * The workbench — the ONE url naming what is being iterated on right now
   * (workbench.ts). Current state, not transcript: it is not replayed here
   * because the server sends the live bench on every connect, the same way it
   * sends `pending` and `tests`.
   */
  | { type: 'workbench'; url: string | null; label?: string }
  /**
   * The MACHINE's voice room (voiceRoom.ts): the universal mute and the one
   * shared volume, for every harness on this Mac. Current state, not
   * transcript — the server sends the live room on every connect, so it does
   * not replay.
   */
  | { type: 'room'; muted: boolean; volume: number }
  | { type: 'cleared' }
  | { type: 'model'; model: string }
  | { type: 'permission'; mode: string }
  | { type: 'speech'; level: string }
  // Reasoning effort, as CHOSEN — empty string means whatever the model does by
  // itself. Not what is in force: the mic ducks that while it is open, and a
  // select that flickered every time he reached for the mic would be a worse
  // readout than none.
  | { type: 'effort'; level: string }
  // Who he is now talking to. Carries the resolved NAME as well as the slug,
  // because a page that only learned the slug would have to guess at the name it
  // puts on a permission card — and '' is a real answer meaning "the repo's own".
  | { type: 'persona'; slug: string; name: string }
  // The health light. Republished whenever the tree moves, not only after a run:
  // "it passed, and that was before your last edit" is a different answer.
  | { type: 'tests'; state: TestState }
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
    } else if (m.type === 'show') {
      // The figure is transcript, so it replays — but the POP is an instruction
      // to grab attention NOW, exactly like `speak`: replaying it would re-open
      // the lightbox on every reconnect. And a surface show is nothing BUT the
      // pop, so none of it reaches history at all.
      if (m.image) {
        this.history.push({ ...m, pop: undefined });
        if (this.history.length > ConversationBus.HISTORY_CAP) this.history.shift();
      }
      // `speak` is an instruction to make a noise NOW. Replaying it would make a
      // reconnecting page perform the whole conversation again, out loud.
    } else if (
      m.type !== 'pending' &&
      m.type !== 'work' &&
      m.type !== 'pointing' &&
      m.type !== 'speak' &&
      m.type !== 'tests' &&
      m.type !== 'workbench' &&
      m.type !== 'room' &&
      // A partial transcript is a moment; replaying an hour of them into a
      // reconnecting tab would render someone's morning into the composer.
      m.type !== 'ear'
    ) {
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
