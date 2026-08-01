// AskGate — the human seam. Two jobs, both riding `canUseTool`:
//
//   1. AskUserQuestion  → render the structured question, PEND until Danny answers.
//   2. everything else  → a genuine permission request (settings didn't auto-approve
//      it), so render an approve/deny card and pend. This is where the repo's
//      prod-safety approvals surface in the UI instead of a terminal.
//
// canUseTool has no timeout — pending indefinitely is its documented purpose.
// Note: auto-approved tools never reach here; gating EVERYTHING would need a
// PreToolUse hook instead.
import type { ConversationBus, AskQuestion } from './bus.ts';
import type { EventLog } from './eventlog.ts';

type Resolver = (value: unknown) => void;

let seq = 0;
const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export class AskGate {
  private pendingAsks = new Map<string, { resolve: Resolver; questions: AskQuestion[] }>();
  private pendingApprovals = new Map<string, Resolver>();

  private bus: ConversationBus;
  private events: EventLog;
  private sessionId: () => string;

  constructor(bus: ConversationBus, events: EventLog, sessionId: () => string) {
    this.bus = bus;
    this.events = events;
    this.sessionId = sessionId;
  }

  /** Wired straight into query({ options: { canUseTool } }). */
  canUseTool = async (toolName: string, input: Record<string, unknown>, opts: { title?: string; description?: string }) => {
    if (toolName === 'AskUserQuestion') return this.handleAsk(input);
    // The harness's own tools are its speech channel, not actions on Danny's
    // behalf — asking him to approve the director talking would be absurd.
    if (toolName.startsWith('mcp__harness__')) return { behavior: 'allow' as const, updatedInput: input };
    return this.handleApproval(toolName, input, opts);
  };

  private async handleAsk(input: Record<string, unknown>) {
    const raw = (input.questions ?? []) as any[];
    const questions: AskQuestion[] = raw.map((q) => ({
      question: q.question,
      header: q.header,
      multiSelect: q.multiSelect,
      options: (q.options ?? []).map((o: any) => ({ label: o.label, description: o.description })),
    }));
    const id = nextId('ask');

    for (const q of questions) {
      this.events.append({ source: 'harness', session: this.sessionId(), kind: 'ask', text: q.question, ref: id });
    }
    this.bus.publish({ type: 'ask', id, questions });

    const answers = await new Promise<Record<string, string>>((resolve) => {
      this.pendingAsks.set(id, { resolve: resolve as Resolver, questions });
    });

    this.bus.publish({ type: 'ask_resolved', id, answers });
    for (const [question, answer] of Object.entries(answers)) {
      this.events.append({
        source: 'harness',
        session: this.sessionId(),
        kind: 'answer',
        text: `${question} → ${answer}`,
        ref: id,
      });
    }
    return { behavior: 'allow' as const, updatedInput: { ...input, answers } };
  }

  private async handleApproval(
    toolName: string,
    input: Record<string, unknown>,
    opts: { title?: string; description?: string }
  ) {
    const id = nextId('appr');
    const detail = opts.description ?? JSON.stringify(input).slice(0, 400);
    this.bus.publish({
      type: 'approval',
      id,
      tool: toolName,
      title: opts.title ?? `Claude wants to use ${toolName}`,
      detail,
    });

    const allowed = await new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(id, resolve as Resolver);
    });

    this.bus.publish({ type: 'approval_resolved', id, allowed });
    return allowed
      ? { behavior: 'allow' as const, updatedInput: input }
      : { behavior: 'deny' as const, message: 'Danny declined this action in the harness UI.' };
  }

  /** Called by the web server when Danny answers. */
  answerAsk(id: string, answers: Record<string, string>): boolean {
    const entry = this.pendingAsks.get(id);
    if (!entry) return false;
    this.pendingAsks.delete(id);
    entry.resolve(answers);
    return true;
  }

  answerApproval(id: string, allowed: boolean): boolean {
    const resolve = this.pendingApprovals.get(id);
    if (!resolve) return false;
    this.pendingApprovals.delete(id);
    resolve(allowed);
    return true;
  }

  /** Re-rendered for a browser that connects while something is pending. */
  outstanding() {
    return {
      asks: [...this.pendingAsks.entries()].map(([id, v]) => ({ id, questions: v.questions })),
      approvals: [...this.pendingApprovals.keys()],
    };
  }
}
