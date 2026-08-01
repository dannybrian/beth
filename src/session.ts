// SessionManager — owns the one long-lived director session.
//
// Streaming input is the spine: a single query({prompt: AsyncIterable}) lives for
// the whole conversation; turns are pushed onto the iterable. The session id is
// persisted so a harness restart resumes the same conversation (cwd must match —
// a cwd mismatch makes resume silently start fresh).
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessConfig } from './config.ts';
import type { ConversationBus, UsageSnapshot } from './bus.ts';
import type { EventLog } from './eventlog.ts';
import type { PendingStore } from './state.ts';
import type { AskGate } from './askgate.ts';
import { createHarnessTools } from './tools.ts';
import { assessRole, roleInstruction, type RoleAssessment } from './directorRole.ts';
import { stripAudioTags, VOCALIZATION_PROMPT } from './audioTags.ts';

type InputStream = AsyncIterable<SDKUserMessage> & { push(m: SDKUserMessage): void; end(): void };

function makeInputStream(): InputStream {
  const queue: SDKUserMessage[] = [];
  let resolvers: (() => void)[] = [];
  let done = false;
  const wake = () => {
    const rs = resolvers;
    resolvers = [];
    for (const r of rs) r();
  };
  return {
    push(m) {
      queue.push(m);
      wake();
    },
    end() {
      done = true;
      wake();
    },
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<SDKUserMessage>> {
          for (;;) {
            if (queue.length) return { value: queue.shift()!, done: false };
            if (done) return { value: undefined as unknown as SDKUserMessage, done: true };
            await new Promise<void>((r) => resolvers.push(r));
          }
        },
      };
    },
  };
}

const userMsg = (text: string): SDKUserMessage =>
  ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' }) as SDKUserMessage;

const PERSONA = [
  'You are Danny\'s standing director, reached through a conversational harness rather than a terminal.',
  'This is a CONVERSATION, not a report surface. Answer in a sentence or a short paragraph. Never dump a status report unless asked for one, never restate what you just did in a bulleted summary.',
  'Use the harness `say` tool for discrete announceable events — one item per call, first sentence stands alone. Ordinary replies still reach Danny as text, so use `say` for mid-work narration and things worth surfacing on their own, not to echo your reply.',
  'Use `queue_decision` for anything Danny should decide but that does not block you. Reserve AskUserQuestion for decisions that genuinely block the work — it pauses the turn.',
  'Answer "what\'s pending?" from the `pending` tool, never from memory.',
  'Work model: answer questions and quick reads inline; dispatch build-shaped work to a background subagent so the conversation stays answerable in seconds.',
].join(' ');

export class SessionManager {
  private q: Query | null = null;
  private input = makeInputStream();
  private sessionIdValue = '';
  private lastCost = 0;
  private modelValue = '';
  role: RoleAssessment;

  private cfg: HarnessConfig;
  private bus: ConversationBus;
  private events: EventLog;
  private pending: PendingStore;
  private gate: AskGate;

  constructor(
    cfg: HarnessConfig,
    bus: ConversationBus,
    events: EventLog,
    pending: PendingStore,
    gate: AskGate
  ) {
    this.cfg = cfg;
    this.bus = bus;
    this.events = events;
    this.pending = pending;
    this.gate = gate;
    this.role = assessRole(cfg.repo, cfg.directorPlan);
  }

  sessionId = () => this.sessionIdValue;
  model = () => this.modelValue;
  /** Set by the VoiceService so `say` can report whether the line was spoken. */
  voiceActive: () => boolean = () => false;

  private sessionFile = () => path.join(this.cfg.stateDir, 'session.json');

  private loadPriorSession(): string | undefined {
    try {
      const { sessionId, cwd } = JSON.parse(fs.readFileSync(this.sessionFile(), 'utf8'));
      // cwd keys session storage; resuming under a different cwd silently starts fresh.
      return cwd === this.cfg.repo ? sessionId : undefined;
    } catch {
      return undefined;
    }
  }

  private persistSession(id: string) {
    fs.writeFileSync(this.sessionFile(), JSON.stringify({ sessionId: id, cwd: this.cfg.repo }, null, 2));
  }

  publishPending = () => {
    this.bus.publish({
      type: 'pending',
      decisions: this.pending.openDecisions(),
      workers: this.pending.runningWorkers(),
    });
  };

  start(kickoff?: string) {
    const resume = this.loadPriorSession();
    this.q = query({
      prompt: this.input,
      options: {
        cwd: this.cfg.repo,
        pathToClaudeCodeExecutable: this.cfg.claudeBin,
        model: this.cfg.model,
        ...(resume ? { resume } : {}),
        // settingSources omitted on purpose — defaults to user+project+local so
        // CLAUDE.md, skills, and repo hooks load exactly like a terminal session.
        mcpServers: {
          harness: createHarnessTools({
            bus: this.bus,
            events: this.events,
            pending: this.pending,
            sessionId: this.sessionId,
            publishPending: this.publishPending,
            voiceActive: this.voiceActive,
          }),
        },
        canUseTool: this.gate.canUseTool,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: `${PERSONA} ${roleInstruction(this.role, this.cfg.directorPlan)} ${VOCALIZATION_PROMPT}`,
        },
      },
    });

    void this.loop();
    if (kickoff) this.send(kickoff, { silent: true });
    return { resumed: Boolean(resume) };
  }

  /** Push a turn. Note: turns pushed close together COALESCE into one turn. */
  send(text: string, opts: { silent?: boolean } = {}) {
    if (!opts.silent) this.bus.publish({ type: 'user', text });
    this.bus.publish({ type: 'status', state: 'thinking' });
    this.input.push(userMsg(text));
  }

  async interrupt() {
    if (!this.q) return undefined;
    const receipt = await this.q.interrupt();
    this.bus.publish({ type: 'status', state: 'idle', detail: 'interrupted' });
    return receipt;
  }

  async contextUsage() {
    return this.q ? this.q.getContextUsage() : null;
  }

  async setEffort(level: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null) {
    await this.q?.applyFlagSettings({ effortLevel: level });
  }

  stop() {
    this.input.end();
  }

  private async loop() {
    try {
      for await (const m of this.q!) await this.handle(m as any);
    } catch (e) {
      // A turn interrupted mid-tool-call closes with an error result, and the SDK
      // re-throws it when the stream ends. Surface it; don't die on it.
      const detail = String(e).slice(0, 300);
      this.bus.publish({ type: 'status', state: 'error', detail });
    }
  }

  private async handle(m: any) {
    switch (m.type) {
      case 'system':
        return this.handleSystem(m);
      case 'assistant':
        return this.handleAssistant(m);
      case 'result':
        return this.handleResult(m);
      default:
        return;
    }
  }

  private handleSystem(m: any) {
    if (m.subtype === 'init') {
      if (m.session_id && m.session_id !== this.sessionIdValue) {
        this.sessionIdValue = m.session_id;
        this.persistSession(m.session_id);
      }
      this.modelValue = m.model ?? this.modelValue;
      return;
    }
    if (m.subtype === 'task_started') {
      const w = this.pending.workerStarted({
        taskId: m.task_id,
        description: m.description ?? 'worker',
        agentType: m.subagent_type,
      });
      this.events.append({
        source: 'harness',
        session: this.sessionIdValue,
        kind: 'worker_started',
        text: w.description,
        ref: w.taskId,
      });
      this.publishPending();
      return;
    }
    if (m.subtype === 'task_notification') {
      // Per-worker TOKENS are attributable here; per-worker dollars are not.
      const w = this.pending.workerFinished(m.task_id, m.status, m.usage?.total_tokens, m.summary);
      this.events.append({
        source: 'harness',
        session: this.sessionIdValue,
        kind: 'worker_done',
        text: `${w?.description ?? m.task_id} ${m.status}${m.usage ? ` (${m.usage.total_tokens} tok)` : ''}`,
        ref: m.task_id,
      });
      this.publishPending();
    }
  }

  private handleAssistant(m: any) {
    for (const b of m.message?.content ?? []) {
      if (b.type === 'text' && b.text.trim()) {
        const raw = b.text.trim();
        this.bus.publish({ type: 'assistant', text: stripAudioTags(raw), voiceText: raw });
      } else if (b.type === 'tool_use' && !String(b.name).endsWith('__say')) {
        const detail = JSON.stringify(b.input ?? {}).slice(0, 200);
        this.bus.publish({ type: 'activity', tool: String(b.name), detail });
      }
    }
  }

  private async handleResult(m: any) {
    let ctxPct = 0;
    let ctxTokens = 0;
    let ctxMax = 0;
    try {
      const c = await this.q!.getContextUsage();
      ctxPct = c.percentage;
      ctxTokens = c.totalTokens;
      ctxMax = c.maxTokens;
    } catch {
      /* context read is best-effort */
    }
    const u = m.usage ?? {};
    const turnCost = (m.total_cost_usd ?? 0) - this.lastCost;
    this.lastCost = m.total_cost_usd ?? this.lastCost;

    const usage: UsageSnapshot = {
      contextPct: ctxPct,
      contextTokens: ctxTokens,
      contextMax: ctxMax,
      turnInput: u.input_tokens ?? 0,
      turnOutput: u.output_tokens ?? 0,
      turnCached: u.cache_read_input_tokens ?? 0,
      turnCost,
      totalCost: m.total_cost_usd ?? 0,
      model: this.modelValue,
    };
    this.bus.publish({ type: 'usage', usage });
    this.bus.publish({
      type: 'status',
      state: m.is_error ? 'error' : 'idle',
      detail: m.is_error ? (m.errors ?? []).join('; ').slice(0, 200) : undefined,
    });
  }
}
