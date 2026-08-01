// The harness tool surface — an in-process MCP server on the director session.
// All alwaysLoad so tool-search never defers their schemas.
//
// There is deliberately NO custom `ask` tool: blocking asks ride the built-in
// AskUserQuestion, intercepted in the AskGate (see askgate.ts).
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ConversationBus } from './bus.ts';
import type { EventLog } from './eventlog.ts';
import type { PendingStore } from './state.ts';
import type { WorkIndex } from './workIndex.ts';
import { taskSummary } from './workItems.ts';
import { stripAudioTags } from './audioTags.ts';

const ok = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });

export function createHarnessTools(deps: {
  bus: ConversationBus;
  events: EventLog;
  pending: PendingStore;
  sessionId: () => string;
  publishPending: () => void;
  voiceActive: () => boolean;
  work: WorkIndex;
}) {
  const say = tool(
    'say',
    'Deliver ONE discrete, announceable event to Danny: mid-work narration, a finding, an async announcement, or a direct answer. One item per call — call it again for the next item. The first sentence must stand alone (it may be heard, not read). `ref` is a plan path, commit sha, or event id.',
    {
      text: z.string().describe('One item. First sentence stands alone. No preamble, no bullet lists.'),
      kind: z.enum(['status', 'finding', 'event', 'answer']),
      ref: z.string().optional().describe('Plan path, commit sha, or event id this refers to.'),
    },
    async ({ text, kind, ref }) => {
      const read = stripAudioTags(text);
      deps.bus.publish({ type: 'say', kind, text: read, voiceText: text, ref });
      // The event log is a reading surface too — store the stripped form.
      deps.events.append({ source: 'harness', session: deps.sessionId(), kind: 'say', text: read, ref });
      return ok({ delivered: true, voiced: deps.voiceActive() });
    },
    { alwaysLoad: true }
  );

  const queueDecision = tool(
    'queue_decision',
    'Add a decision to Danny\'s pending queue WITHOUT blocking. Prefer this over AskUserQuestion unless work genuinely cannot proceed without the answer. Returns immediately with a ticket id; the answer arrives later as a normal user turn.',
    {
      title: z.string().describe('One line, the decision itself.'),
      context: z.string().describe('What Danny needs to know to decide. A few sentences at most.'),
      options: z.array(z.string()).optional().describe('Candidate answers, if the decision is a choice.'),
      plan: z.string().optional().describe('Plan path this decision belongs to.'),
      urgency: z.enum(['when-free', 'today', 'blocking-later']),
    },
    async ({ title, context, options, plan, urgency }) => {
      const rec = deps.pending.queueDecision({ title, context, options, plan, urgency });
      deps.events.append({
        source: 'harness',
        session: deps.sessionId(),
        kind: 'decision_queued',
        text: title,
        ref: plan ?? rec.id,
      });
      deps.publishPending();
      return ok({ queued: true, id: rec.id });
    },
    { alwaysLoad: true }
  );

  const pending = tool(
    'pending',
    'Read back what is currently pending: unresolved queued decisions, running workers, and recent events. Answer "what\'s pending?" from THIS, never from memory.',
    {},
    async () => {
      const decisions = deps.pending.openDecisions().map((d) => ({
        id: d.id,
        title: d.title,
        urgency: d.urgency,
        plan: d.plan,
        queuedAt: d.queuedAt,
      }));
      const workers = deps.pending.runningWorkers().map((w) => ({
        taskId: w.taskId,
        description: w.description,
        agentType: w.agentType,
        startedAt: w.startedAt,
      }));
      const events = deps.events.recent(15).map((e) => ({ ts: e.ts, kind: e.kind, text: e.text, ref: e.ref }));
      return ok({ decisions, workers, recentEvents: events });
    },
    { alwaysLoad: true }
  );

  /**
   * The SAME index the panel renders. This is the point of the whole design: when
   * Danny glances at the panel and when he asks "what's in flight?" out loud, the
   * two answers come from one place. Answering from memory or by reading plan
   * files directly re-opens exactly the disagreement this closes.
   */
  const plans = tool(
    'plans',
    'The live index of this project\'s plans — status, task progress, and who holds a claim. Current within milliseconds; the panel Danny is looking at renders THIS. Answer "what\'s in flight?", "what\'s the status of X?" and anything about plan progress from here. Pass tasks:true for the full checklist of a plan. Do NOT grep or read plan files to count tasks: this index already parsed them and correctly ignores checkboxes inside code fences, which a grep does not — you would get a different number than the panel Danny is looking at. Read the file only when he asks about a plan\'s actual prose.',
    {
      scope: z
        .enum(['in-flight', 'all'])
        .default('in-flight')
        .describe('in-flight = active, blocked and planning. Use all only when explicitly asked about parked or shipped work.'),
      match: z.string().optional().describe('Filter to plans whose spoken name, title or path contains this.'),
      tasks: z.boolean().default(false).describe('Include the full task list per plan, not just counts. Verbose — ask for it only when the tasks themselves are the question.'),
    },
    async ({ scope, match, tasks }) => {
      const base = scope === 'all' ? deps.work.all() : deps.work.inFlight();
      const needle = match?.toLowerCase();
      const hits = needle
        ? base.filter((i) =>
            [i.spoken, i.title, i.path].some((f) => f.toLowerCase().includes(needle))
          )
        : base;

      return ok({
        total: hits.length,
        // Spoken names are the point — say these aloud, never the paths.
        plans: hits.slice(0, tasks ? 25 : 120).map((i) => {
          const t = taskSummary(i);
          return {
            spoken: i.spoken,
            title: i.title,
            path: i.path,
            status: i.status,
            priority: i.priority,
            lastTouched: i.lastTouched,
            // null means the plan has no checkboxes — say "no tasks", never "0%".
            tasks: t,
            claimedBy: i.claim?.live ? i.claim.owner : undefined,
            staleOwner: i.claim && !i.claim.live ? i.claim.owner : undefined,
            ...(tasks ? { taskList: i.tasks.map((x) => ({ done: x.done, text: x.spoken, line: x.line })) } : {}),
          };
        }),
        note: 'Refer to a plan by its `spoken` name in conversation. Never read a path aloud.',
      });
    },
    { alwaysLoad: true }
  );

  return createSdkMcpServer({
    name: 'harness',
    version: '1.0.0',
    tools: [say, queueDecision, pending, plans],
  });
}
