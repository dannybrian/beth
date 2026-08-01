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
import { stripAudioTags } from './audioTags.ts';

const ok = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });

export function createHarnessTools(deps: {
  bus: ConversationBus;
  events: EventLog;
  pending: PendingStore;
  sessionId: () => string;
  publishPending: () => void;
  voiceActive: () => boolean;
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

  return createSdkMcpServer({
    name: 'harness',
    version: '1.0.0',
    tools: [say, queueDecision, pending],
  });
}
