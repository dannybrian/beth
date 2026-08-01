// AskGate — the human seam. Two jobs, both riding `canUseTool`:
//
//   1. AskUserQuestion  → render the structured question, PEND until Danny answers.
//   2. everything else  → a genuine permission request (settings didn't auto-approve
//      it), so render an approve/deny card and pend. This is where the repo's
//      prod-safety approvals surface in the UI instead of a terminal.
//
// canUseTool has no timeout — pending indefinitely is its documented purpose,
// and here it is also the sharpest edge: a card is UNANSWERABLE BY VOICE, so
// every prompt that reaches it stops a spoken conversation dead. That is why the
// session runs in the SDK's 'auto' permission mode by default (see config.ts) and
// why "Always" exists below — this seam should be reached rarely and, once
// answered for a given action, not reached again.
//
// Note: auto-approved tools never reach here at all; gating EVERYTHING would need
// a PreToolUse hook instead.
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { ConversationBus, AskQuestion } from './bus.ts';
import type { EventLog } from './eventlog.ts';

type Resolver = (value: unknown) => void;

/** Once, always (for this conversation), or no. */
export type ApprovalVerdict = 'once' | 'always' | 'deny';

/**
 * Always-allow, scoped to THIS conversation.
 *
 * The SDK's suggestions carry their own destination, which is usually a settings
 * FILE in the bound repo. Writing there from a click in the harness edits the
 * project durably, from a button labelled "Always", in a place Danny cannot see
 * from this page. Session scope is the honest reading of what the button says: it
 * stops the repeat asks for as long as this director is up, and dies with it.
 * Anything he wants to hold across restarts belongs in the repo's own settings,
 * written deliberately.
 */
const forThisSession = (u: PermissionUpdate): PermissionUpdate => ({ ...u, destination: 'session' });

let seq = 0;
const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export class AskGate {
  private pendingAsks = new Map<string, { resolve: Resolver; questions: AskQuestion[] }>();
  private pendingApprovals = new Map<string, Resolver>();

  private bus: ConversationBus;
  private events: EventLog;
  private sessionId: () => string;
  /** What to call her on the card — the bound repo's director, not "Claude". */
  private director: string;

  constructor(bus: ConversationBus, events: EventLog, sessionId: () => string, director: string) {
    this.bus = bus;
    this.events = events;
    this.sessionId = sessionId;
    this.director = director;
  }

  /** Wired straight into query({ options: { canUseTool } }). */
  canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
    opts: { title?: string; description?: string; suggestions?: PermissionUpdate[] }
  ) => {
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
    opts: { title?: string; description?: string; suggestions?: PermissionUpdate[] }
  ) {
    const id = nextId('appr');
    const detail = opts.description ?? JSON.stringify(input).slice(0, 400);
    // The rules that would stop this being asked again — the SDK works out what
    // "always" would have to mean for THIS call (this tool, this command prefix,
    // this path), which is not something the harness should be guessing at.
    const suggestions = opts.suggestions ?? [];
    this.bus.publish({
      type: 'approval',
      id,
      tool: toolName,
      // The bridge writes "Claude wants to read foo.txt". In this harness the
      // person asking is the project's director — Danny is mid-conversation with
      // her, and a prompt from someone else reads as a different program.
      title: (opts.title ?? `Claude wants to use ${toolName}`).replace(/^Claude\b/, this.director),
      detail,
      canAlways: suggestions.length > 0,
    });

    const verdict = await new Promise<ApprovalVerdict>((resolve) => {
      this.pendingApprovals.set(id, resolve as Resolver);
    });

    this.bus.publish({ type: 'approval_resolved', id, allowed: verdict !== 'deny', always: verdict === 'always' });
    if (verdict === 'deny') {
      return { behavior: 'deny' as const, message: 'Danny declined this action in the harness UI.' };
    }
    return {
      behavior: 'allow' as const,
      updatedInput: input,
      ...(verdict === 'always' ? { updatedPermissions: suggestions.map(forThisSession) } : {}),
    };
  }

  /** Called by the web server when Danny answers. */
  answerAsk(id: string, answers: Record<string, string>): boolean {
    const entry = this.pendingAsks.get(id);
    if (!entry) return false;
    this.pendingAsks.delete(id);
    entry.resolve(answers);
    return true;
  }

  answerApproval(id: string, verdict: ApprovalVerdict): boolean {
    const resolve = this.pendingApprovals.get(id);
    if (!resolve) return false;
    this.pendingApprovals.delete(id);
    resolve(verdict);
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
