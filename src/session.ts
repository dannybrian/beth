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
import type { WorkIndex } from './workIndex.ts';
import type { WorkRef } from './workItems.ts';
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

// The GENERIC director. Identity — name, voice, who they work with, repo-specific
// standing orders — is supplied by the bound repo in .claude/DIRECTOR.md, so the
// harness stays project-agnostic and each repo gets its own director.
const PERSONA = [
  // --- the role ---
  'You are the standing director on this project, reached through a conversational harness rather than a terminal.',
  'You are an expert project and development manager. That is the centre of gravity: you hold the shape of the work, you know what is in flight and what is blocked, you are decisive about sequencing, and you protect your collaborator\'s attention. Competence first — you are the person who has already read the plan.',
  // --- how you talk ---
  'This is a CONVERSATION, not a report surface. Answer in a sentence or a short paragraph. Never dump a status report unless asked for one, and never restate what you just did in a bulleted summary.',
  'You are frequently HEARD rather than read, so write like someone speaking: lead with the answer, keep sentences sayable, and skip anything that only works on a page (tables, bullet lists, file paths read aloud character by character).',
  // --- how she works ---
  'Use the harness `say` tool for discrete announceable events — one item per call, first sentence stands alone. Ordinary replies still reach Danny as text, so use `say` for mid-work narration and things worth surfacing on their own, not to echo your reply.',
  'Use `queue_decision` for anything Danny should decide but that does not block you. Reserve AskUserQuestion for decisions that genuinely block the work — it pauses the turn.',
  'Answer "what\'s pending?" from the `pending` tool, and anything about plans — what is in flight, a plan\'s status, how far along it is, what its tasks are — from the `plans` tool. Never from memory, and never by grepping plan files: the index and the panel Danny is looking at are the same source, and a hand-rolled count will disagree with what he can see.',
  // Deixis: Danny points at a plan in the panel, and the turn arrives carrying a
  // spoken name for it. Reading the path aloud instead is the exact failure the
  // reference pair exists to prevent.
  'When a turn tells you Danny is POINTING at something, treat that as what "this" and "that" refer to. Call it by the quoted spoken name, in speech and in writing. Never read a file path aloud.',
  'A plan with no tasks has no checkboxes yet — say "no tasks", never "nothing done" or "0%".',
  'Work model: answer questions and quick reads inline; dispatch build-shaped work to a background subagent so the conversation stays answerable in seconds.',
].join(' ');

export class SessionManager {
  private q: Query | null = null;
  private input = makeInputStream();
  private sessionIdValue = '';
  private lastCost = 0;
  private modelValue = '';
  private turnSeq = 0;
  private interruptPending = false;
  /** Survives /clear, so a model chosen in the UI sticks to the next conversation. */
  private modelChoice = '';
  role: RoleAssessment;

  private cfg: HarnessConfig;
  private bus: ConversationBus;
  private events: EventLog;
  private pending: PendingStore;
  private gate: AskGate;
  private work: WorkIndex;

  constructor(
    cfg: HarnessConfig,
    bus: ConversationBus,
    events: EventLog,
    pending: PendingStore,
    gate: AskGate,
    work: WorkIndex
  ) {
    this.cfg = cfg;
    this.bus = bus;
    this.events = events;
    this.pending = pending;
    this.gate = gate;
    this.work = work;
    this.role = assessRole(cfg.repo, cfg.directorPlan);
  }

  sessionId = () => this.sessionIdValue;
  model = () => this.modelValue;
  /** Set by the VoiceService so `say` can report whether the line was spoken. */
  voiceActive: () => boolean = () => false;

  private sessionFile = () => path.join(this.cfg.stateDir, 'session.json');

  /**
   * The bound repo's own instructions for its director: who she is, what she is
   * called, how she should behave here. This is the repo-side half of the harness
   * contract — the harness supplies the role, the project supplies the person.
   * Absent file is fine; you get a competent, unnamed director.
   */
  private repoDirectorGuide(): string {
    const file = path.join(this.cfg.repo, '.claude', 'DIRECTOR.md');
    try {
      const body = fs.readFileSync(file, 'utf8').trim();
      if (!body) return '';
      console.log(`  director: loaded ${path.relative(this.cfg.repo, file)} (${body.length} chars)`);
      return `\n\nThe project you are bound to provides these instructions about who you are and how to work here. They take precedence over the generic guidance above:\n\n${body}`;
    } catch {
      console.log('  director: no .claude/DIRECTOR.md in this repo — running as a generic director');
      return '';
    }
  }

  /**
   * Every launch is a clean conversation by default. Resuming across days let stale
   * context accumulate — and it buys less than it appears to: of ~51k tokens, only
   * ~9k was message history. The rest is fixed prefix (memory files, tool schemas)
   * that a fresh session pays for anyway.
   *
   * The session id is still written on every run, so `HARNESS_RESUME=1` can pick up
   * exactly where the last one left off when that is what you want.
   */
  private loadPriorSession(): string | undefined {
    if (process.env.HARNESS_RESUME !== '1') return undefined;
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

  start(kickoff?: string, opts: { allowResume?: boolean } = {}) {
    const resume = opts.allowResume === false ? undefined : this.loadPriorSession();
    this.q = query({
      prompt: this.input,
      options: {
        cwd: this.cfg.repo,
        pathToClaudeCodeExecutable: this.cfg.claudeBin,
        model: this.modelChoice || this.cfg.model,
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
            work: this.work,
          }),
        },
        canUseTool: this.gate.canUseTool,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append:
            `${PERSONA} ${roleInstruction(this.role, this.cfg.directorPlan)} ${VOCALIZATION_PROMPT}` +
            this.repoDirectorGuide(),
        },
      },
    });

    void this.loop();
    if (kickoff) this.send(kickoff, { silent: true });
    return { resumed: Boolean(resume) };
  }

  /**
   * Push a turn. Returns a turn number that later `status` messages carry, so a
   * consumer can tell ITS turn finishing from any other turn finishing — without
   * that, a voice stream ends on whatever `idle` happens to arrive first.
   * Note: turns pushed close together COALESCE into one turn.
   *
   * `display` splits what Beth RECEIVES from what the transcript SHOWS. A turn
   * carrying references is prefixed with a block naming what Danny pointed at;
   * showing him that block back would bury the sentence he actually typed.
   */
  send(text: string, opts: { silent?: boolean; display?: string; refs?: WorkRef[] } = {}): number {
    const turn = ++this.turnSeq;
    if (!opts.silent) this.bus.publish({ type: 'user', text: opts.display ?? text, refs: opts.refs });
    this.bus.publish({ type: 'status', state: 'thinking', turn });
    this.input.push(userMsg(text));
    return turn;
  }

  /**
   * A turn Danny originated — typed or SPOKEN — which consumes whatever he is
   * currently pointing at in the plans panel.
   *
   * Both input paths go through here so they cannot drift. It is deliberately
   * NOT folded into send(): a resolved decision or the promote nudge are turns
   * too, and they must not silently eat a reference he was holding for his next
   * question.
   */
  sendPointed(text: string): number {
    const refs = this.work.takePointed();
    const preamble = this.work.preamble(refs);
    return this.send(preamble ? `${preamble}\n${text}` : text, {
      display: text || `(pointing at ${refs.map((r) => `"${r.spoken}"`).join(', ')})`,
      refs,
    });
  }

  /**
   * Abort the in-flight turn — the Stop button, and the equivalent of Escape in
   * Claude Code. The session survives; the next turn continues normally.
   *
   * The CLI closes an interrupted turn with an `error_during_execution` result,
   * so the flag below lets the result handler report it as a deliberate stop
   * rather than rendering a scary diagnostic at Danny for pressing a button.
   */
  async interrupt() {
    if (!this.q) return undefined;
    this.interruptPending = true;
    const receipt = await this.q.interrupt();
    this.bus.publish({ type: 'status', state: 'idle', detail: 'stopped', turn: this.turnSeq });
    return receipt;
  }

  async contextUsage() {
    return this.q ? this.q.getContextUsage() : null;
  }

  async setEffort(level: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null) {
    await this.q?.applyFlagSettings({ effortLevel: level });
  }

  /**
   * Switch models mid-conversation. `setModel` works on a live streaming query,
   * so the context is kept — no restart, no lost history. Recorded so a later
   * /clear starts its new session on the same choice.
   */
  async setModel(model: string) {
    this.modelChoice = model;
    await this.q?.setModel(model);
    this.modelValue = model;
    this.bus.publish({ type: 'model', model });
  }

  /** The model this conversation is running on. */
  chosenModel = () => this.modelChoice || this.cfg.model;

  stop() {
    this.input.end();
  }

  /**
   * Start a brand-new conversation without restarting the harness — `/clear`.
   *
   * Drops the model's context and the transcript. Deliberately does NOT touch the
   * pending queues or running workers: those are work, not conversation, and
   * losing a queued decision because you cleared the chat would be a nasty
   * surprise. Beth is still Beth afterwards — the persona is in the system prompt,
   * which the new session rebuilds.
   */
  async clear() {
    try {
      await this.interrupt();
    } catch {
      /* nothing in flight */
    }
    this.input.end();
    this.q = null;
    this.input = makeInputStream();
    this.sessionIdValue = '';
    this.lastCost = 0;
    this.turnSeq = 0;
    this.interruptPending = false;
    this.start(undefined, { allowResume: false });
    this.bus.clear();
    this.bus.publish({ type: 'cleared' });
    this.bus.publish({ type: 'status', state: 'idle' });
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

    // An interrupted turn always ends in error_during_execution. That is the
    // expected shape of a deliberate stop, not a failure worth alarming about.
    const wasStopped = m.is_error && this.interruptPending;
    this.interruptPending = false;
    this.bus.publish({
      type: 'status',
      state: m.is_error && !wasStopped ? 'error' : 'idle',
      turn: this.turnSeq,
      detail: wasStopped ? 'stopped' : m.is_error ? (m.errors ?? []).join('; ').slice(0, 200) : undefined,
    });
  }
}
