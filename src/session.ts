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
import type { EffortLevel, HarnessConfig } from './config.ts';
import type { ConversationBus, UsageSnapshot } from './bus.ts';
import type { EventLog } from './eventlog.ts';
import type { PendingStore } from './state.ts';
import type { AskGate } from './askgate.ts';
import type { WorkIndex } from './workIndex.ts';
import type { WorkRef } from './workItems.ts';
import type { SpeechControl } from './spoken.ts';
import { detectLinks } from './links.ts';
import { createHarnessTools } from './tools.ts';
import { assessRole, roleInstruction, type RoleAssessment } from './directorRole.ts';
import { PersonalStore, PERSONAL_PROMPT, GAP_MS } from './personal.ts';
import { PersonaChoice, personaStateDir, readPersona, seedMemory } from './personas.ts';
import { WireTap } from './wireTap.ts';
import type { Workbench } from './workbench.ts';
import { stripAudioTags, VOCALIZATION_PROMPT } from './audioTags.ts';
import { renderInline } from './markdown.ts';
import { summarizeTool } from './activity.ts';

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
  // Being heard changes what silence MEANS. On a page, a gap is just a gap; in a
  // room it is indistinguishable from a hang — and he cannot stop you if he never
  // heard you start.
  'Before anything that will take longer than a breath — running a suite, shipping a plan, a deploy, a sweep of commits — say what you are about to do first, in one short line: "Let me ship it." / "Hold on, running the suites." Name the action, not the mechanics. Then close the loop out loud when it lands: finishing silently reads as failure no matter how green the run.',
  // --- how she works ---
  'Use the harness `say` tool for discrete announceable events — one item per call, first sentence stands alone. Ordinary replies still reach Danny as text, so use `say` for mid-work narration and things worth surfacing on their own, not to echo your reply.',
  // The visual channel exists because he is often LISTENING, not reading — a
  // diagram he can glance at beats a paragraph describing one, and "you have
  // three things waiting" lands better with the queue on screen.
  'You also have a SCREEN: `show` puts an image from the repo into the conversation, or opens his pending queue full-size (`surface: "pending"`) when you are telling him what waits on him. Reach for it whenever a picture answers better than prose — especially when he is listening rather than reading. Add `pop: true` only when he should look right now; it opens over the page he is looking at, so it is "look at this", not decoration. The tool makes no sound — say what you are showing.',
  'Use `queue_decision` for anything Danny should decide but that does not block you. Reserve AskUserQuestion for decisions that genuinely block the work — it pauses the turn.',
  // The queue is only worth looking at if everything in it is still waiting.
  'The queue is YOURS TO KEEP CLEAN. When he answers a queued decision in conversation, or it stops mattering because the work moved, close it with `close_decision` in the same turn — an item he has already dealt with, still sitting there, is how a queue stops being worth a glance. When you offer candidate answers, give them as `options`: they are buttons he can press, not a list to read out.',
  'Answer "what\'s pending?" from the `pending` tool, and anything about plans — what is in flight, a plan\'s status, how far along it is, what its tasks are — from the `plans` tool. Never from memory, and never by grepping plan files: the index and the panel Danny is looking at are the same source, and a hand-rolled count will disagree with what he can see.',
  // Deixis: Danny points at a plan in the panel, and the turn arrives carrying a
  // spoken name for it. Reading the path aloud instead is the exact failure the
  // reference pair exists to prevent.
  'When a turn tells you Danny is POINTING at something, treat that as what "this" and "that" refer to. Call it by the quoted spoken name, in speech and in writing. Never read a file path aloud.',
  'A plan with no tasks has no checkboxes yet — say "no tasks", never "nothing done" or "0%".',
  'Work model: answer questions and quick reads inline; dispatch build-shaped work to a background subagent so the conversation stays answerable in seconds.',
  // Workers INHERIT the conversation's model unless a dispatch names one, and
  // the conversation deliberately runs the expensive tier. Left alone that is
  // the priciest model on the roster doing grep sweeps — noticed in real use
  // (three beths, every worker on Fable), not hypothetically. Tier names, not
  // pinned ids: the Agent tool takes them, and this prompt should not need
  // editing when a model version rolls. The sonnet/opus line is drawn by what
  // the dispatch RELIES ON, not by task category — "architecture vs mechanical"
  // was only this rule's most common shadow.
  'Name a model on every worker you dispatch — workers inherit yours by default, and yours is for this conversation, never for delegation. The line: "sonnet" when the spec is the work — mechanical refactors, test updates following a known change, index and status sweeps, anything where doing exactly what the brief says IS success. "opus" when you are relying on the worker to notice something you could not specify in advance — a brief that says "stop and tell me if", debugging that has resisted an attempt, work whose point is catching a fault nobody has imagined yet. The repo\'s own guide maps which of ITS territories fall on the opus side, and wins where it speaks.',
].join(' ');

export class SessionManager {
  private q: Query | null = null;
  private input = makeInputStream();
  private sessionIdValue = '';
  private lastCost = 0;
  private modelValue = '';
  private turnSeq = 0;
  private interruptPending = false;
  /**
   * What she remembers about the PERSON. Null-behaviour lives inside the store.
   *
   * Not readonly: a persona switch re-points it, because the memory belongs to
   * the director rather than to the harness. Everything that holds one gets it
   * through `start()`, which a switch re-runs.
   */
  personal: PersonalStore;
  /** Who she is, when Danny has chosen rather than inherited. See personas.ts. */
  private personaChoice: PersonaChoice;
  /** When Danny last said something, so an arrival can be told from mid-work. */
  private lastHumanTurnAt = 0;
  /** Survives /clear, so a model chosen in the UI sticks to the next conversation. */
  private modelChoice = '';
  /** Likewise for the permission mode — /clear drops context, not preferences. */
  private permissionChoice: HarnessConfig['permissionMode'] | '' = '';
  role: RoleAssessment;
  /** The wire tap — every SDK message, compactly, for the panel to pull. */
  readonly wire = new WireTap();

  private cfg: HarnessConfig;
  private bus: ConversationBus;
  private events: EventLog;
  private pending: PendingStore;
  private gate: AskGate;
  private work: WorkIndex;
  private speech: SpeechControl;
  private bench: Workbench;

  constructor(
    cfg: HarnessConfig,
    bus: ConversationBus,
    events: EventLog,
    pending: PendingStore,
    gate: AskGate,
    work: WorkIndex,
    speech: SpeechControl,
    bench: Workbench
  ) {
    this.cfg = cfg;
    this.bus = bus;
    this.events = events;
    this.pending = pending;
    this.gate = gate;
    this.work = work;
    this.speech = speech;
    this.bench = bench;
    this.role = assessRole(cfg.repo, cfg.directorPlan);
    this.personaChoice = new PersonaChoice(cfg.stateDir);
    const persona = this.personaChoice.current();
    if (persona) seedMemory(persona.slug, persona.name, cfg.directorName, cfg.stateDir);
    this.personal = new PersonalStore(cfg, persona ? personaStateDir(persona.slug) : undefined);
  }

  /** The persona in force, or null when the bound repo's own guide is the whole of it. */
  persona = () => this.personaChoice.current();

  /**
   * What to CALL her: the chosen person, else what the repo named.
   *
   * A card reading "Claude wants to use Bash" is a stranger interrupting a
   * conversation with someone else, and so is a card naming yesterday's director.
   */
  directorName = () => this.persona()?.name || this.cfg.directorName;

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
  /**
   * The chosen person, when there is one.
   *
   * Placed BEFORE the repo's guide, and said to be about identity rather than
   * about the work: the two compose, and where they overlap the project's
   * standing orders are the more specific instruction and win. A persona that
   * silently overrode "never deploy on a Friday" would be a costume with
   * authority.
   */
  private personaGuide(): string {
    const p = this.persona();
    if (!p?.guide) return '';
    console.log(`  persona: ${p.name} (${p.slug})${p.voiceId ? ' · own voice' : ''}`);
    return `\n\nWho you are:\n\n${p.guide}`;
  }

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

  /** File references in text she has written, for the page to make clickable. */
  private links(text: string) {
    return detectLinks(text, { repo: this.cfg.repo, lookup: (p) => this.work.byPath(p) });
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
        // 'auto' by default: a card cannot be answered by voice, so every prompt
        // that reaches the gate stops a spoken conversation until Danny is back at
        // the page. See config.ts for why bypass is not on the menu.
        permissionMode: this.chosenPermissionMode(),
        // For the wire tap: stream events carry the SDK's own time-to-first-token
        // stamp and the content-block boundaries the anatomy strip is drawn
        // from. The deltas themselves are folded away at capture (wireTap.ts).
        includePartialMessages: true,
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
            repo: this.cfg.repo,
            personal: this.personal.enabled ? this.personal : null,
            speech: this.speech,
            bench: this.bench,
          }),
        },
        canUseTool: this.gate.canUseTool,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append:
            `${PERSONA} ${roleInstruction(this.role, this.cfg.directorPlan)} ${VOCALIZATION_PROMPT}` +
            (this.personal.enabled ? ` ${PERSONAL_PROMPT}` : '') +
            this.personaGuide() +
            this.repoDirectorGuide() +
            // Fixed for the life of the session, which is right: this is what she
            // knows on arrival. Anything learned mid-session is in the tool.
            this.personal.promptBlock(),
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
    // What Danny actually sent — scaffolding included, because the panel's job
    // is precisely to show what the transcript does not.
    this.wire.userTurn(turn, text);
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
    // The two moments a personal beat is allowed are the boot greeting and the
    // first turn after a LONG GAP — he is arriving, not returning mid-task. Any
    // other turn is work in progress, and interrupting that to ask how his week
    // is going is the opposite of protecting his attention.
    const arriving = this.lastHumanTurnAt > 0 && Date.now() - this.lastHumanTurnAt > GAP_MS;
    this.lastHumanTurnAt = Date.now();
    const beat = arriving ? this.personal.beat() : null;
    const refs = this.work.takePointed();
    const preamble = this.work.preamble(refs);
    // ⚠️ EVERY scaffold goes on the model's copy only, and `text` stays exactly
    // what he said. Both of these are instructions to her about how to answer —
    // the preamble naming what he pointed at, the beat inviting one human line —
    // and both were written to be invisible. The beat was not: it was appended
    // to `text` before `display` was taken from it, so a note addressed to Beth
    // was rendered in the transcript as a sentence Danny had apparently typed.
    let forModel = beat ? `${text}\n\n[harness: ${beat}]` : text;
    if (preamble) forModel = `${preamble}\n${forModel}`;
    return this.send(forModel, {
      // Falls back to the pointing line only when he genuinely said nothing —
      // which a beat glued onto an empty string used to make impossible.
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

  /**
   * Plan rate-limit windows — five-hour, seven-day, per-model — or null.
   *
   * ⚠️ The method name IS the warning, so everything here is defensive: feature-
   * detect it, call it through a cast, and swallow whatever comes back out. The
   * windows are the reason the stats panel is worth opening rather than merely
   * rearranged, but they must never be the reason it fails to open — the local
   * numbers are always there and always right.
   *
   * `rate_limits_available` is false for API-key, Bedrock and Vertex sessions,
   * which is not an error: it means this session is not on a plan.
   */
  async planUsage(): Promise<Record<string, unknown> | null> {
    const q = this.q as any;
    const fn = q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof fn !== 'function') return null;
    try {
      return await fn.call(q);
    } catch {
      return null;
    }
  }

  /**
   * Reasoning effort has TWO owners, and they must not overwrite each other.
   *
   * Danny picks a level in the strip and it stands until he changes it; the mic
   * ducks it to `voiceEffort` for as long as it is open, because spoken
   * conversation trades depth for latency. The bug that shape invites is the mic
   * closing and restoring "default" over a choice made while it was open — so
   * the CHOICE is remembered separately from what is in force, and closing the
   * mic restores the choice rather than nothing.
   */
  private effortChoice: EffortLevel = null;
  /** What is actually applied, so a new session after /clear starts on it. */
  private effortInForce: EffortLevel = null;
  private effortDucked = false;

  private async applyEffort(level: EffortLevel) {
    this.effortInForce = level;
    await this.q?.applyFlagSettings({ effortLevel: level });
  }

  /** The level Danny chose; null is the model's own default. */
  chosenEffort = () => this.effortChoice;

  /** The durable choice. Takes hold now unless the mic is holding it down. */
  async setEffort(level: EffortLevel) {
    this.effortChoice = level;
    if (!this.effortDucked) await this.applyEffort(level);
    this.bus.publish({ type: 'effort', level: level ?? '' });
  }

  /**
   * The mic's temporary override. `null` means the mic closed — restore the
   * choice, which is the whole reason these are two calls and not one.
   */
  async duckEffort(level: EffortLevel) {
    this.effortDucked = level !== null;
    await this.applyEffort(level ?? this.effortChoice);
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

  /** How this conversation resolves tool permissions. */
  chosenPermissionMode = (): HarnessConfig['permissionMode'] => this.permissionChoice || this.cfg.permissionMode;

  /**
   * Change who he is talking to.
   *
   * ⚠️ This one CANNOT be done live, and that is not an oversight to be fixed
   * later. Model, permission mode and effort all have setters on a running query;
   * the system prompt does not — it is fixed when the query is constructed, and
   * `reinitialize()` is for transport gaps, not for becoming someone else. So a
   * persona switch is a `/clear`: a new session, on the same repo, with a
   * different person in it.
   *
   * Which is the right shape anyway. You do not swap who you are talking to
   * mid-thought, and carrying one director's conversation into another's head
   * would be a stranger reading your last hour. The page says so before it asks.
   */
  async setPersona(slug: string) {
    const persona = slug ? readPersona(slug) : null;
    if (slug && !persona) return null;
    this.personaChoice.set(persona ? persona.slug : '');
    // Her memory moves with her — and is seeded once from what the repo's own
    // director already knew, when they are the same person. See seedMemory.
    if (persona) seedMemory(persona.slug, persona.name, this.cfg.directorName, this.cfg.stateDir);
    this.personal = new PersonalStore(this.cfg, persona ? personaStateDir(persona.slug) : undefined);
    // Her voice is part of who she is. A swap that kept the last one would be
    // half a swap, and the wrong half.
    this.speech.setVoice?.(persona?.voiceId ?? null);
    this.events.append({
      source: 'harness',
      session: this.sessionIdValue,
      kind: 'persona',
      text: `director → ${persona?.name ?? 'the repo default'}`,
    });
    // ⚠️ AFTER the clear, not before. `clear()` empties the transcript on every
    // page, so a switch announced first announces itself into a transcript that
    // is about to be thrown away — and the one turn where you want to see who
    // you are now talking to is the empty one.
    await this.clear();
    this.bus.publish({ type: 'persona', slug: persona?.slug ?? '', name: this.directorName() });
    return persona;
  }

  /**
   * Switch permission mode mid-conversation. Like setModel, this works on a live
   * streaming query — no restart, no lost context — so Danny can loosen it for a
   * long unattended run and tighten it again when the work turns towards prod.
   */
  async setPermissionMode(mode: HarnessConfig['permissionMode']) {
    this.permissionChoice = mode;
    await this.q?.setPermissionMode(mode);
    this.bus.publish({ type: 'permission', mode });
  }

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
    // Effort is a flag on the QUERY, not an option it was constructed with, so a
    // replaced session comes up at the model's default and the strip would go on
    // claiming the old level. Re-applied to what was in force, which is the duck
    // level if he cleared with the mic open.
    if (this.effortInForce) void this.applyEffort(this.effortInForce).catch(() => {});
    // ⚠️ The queues survive a clear; the WORKER ROSTER cannot. A worker is a task
    // inside the SDK session, and the session it ran in has just been replaced —
    // its `task_notification` is never coming, so anything still marked running
    // would sit in the panel forever with the activity dot lit behind it.
    const orphaned = this.pending.orphanWorkers();
    if (orphaned) {
      this.events.append({
        source: 'harness',
        session: this.sessionIdValue,
        kind: 'worker_done',
        text: `${orphaned} worker${orphaned === 1 ? '' : 's'} dropped — the conversation was cleared`,
      });
    }
    this.publishPending();
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
    // The tap sees EVERYTHING, including the types the switch below ignores —
    // that difference is the whole point of the wire panel.
    this.wire.record(m);
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
    if (m.subtype === 'background_tasks_changed') {
      // The level signal: every live background task, REPLACE semantics. This
      // is what unwedges a worker whose task_notification never came — the
      // task died, an interrupt ate it — without enumerating the causes. See
      // reconcileWorkers for the grace window and why unknown ids are ignored.
      // A CLI that predates the message simply never sends it, and the roster
      // behaves as it always did: manual dismissal.
      const live = new Set((m.tasks ?? []).map((t: any) => String(t.task_id)));
      const closed = this.pending.reconcileWorkers(live);
      for (const w of closed) {
        this.events.append({
          source: 'harness',
          session: this.sessionIdValue,
          kind: 'worker_done',
          text: `${w.description} ended without a notification — dropped on reconcile`,
          ref: w.taskId,
        });
      }
      if (closed.length) this.publishPending();
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
        // Markers off BEFORE links are detected: both overlays index this exact
        // string, so the page can never splice one against stale offsets.
        const { text: read, spans } = renderInline(stripAudioTags(raw));
        this.bus.publish({ type: 'assistant', text: read, spans, voiceText: raw, links: this.links(read) });
      } else if (b.type === 'tool_use' && !String(b.name).endsWith('__say')) {
        const detail = JSON.stringify(b.input ?? {}).slice(0, 200);
        this.bus.publish({
          type: 'activity',
          tool: String(b.name),
          detail,
          summary: summarizeTool(String(b.name), b.input ?? {}, this.cfg.repo),
        });
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
