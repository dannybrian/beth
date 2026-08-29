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
import type { PersonalStore, PersonalKind } from './personal.ts';
import { taskSummary } from './workItems.ts';
import { SPEECH_LEVELS, type SpeechControl, type SpeechLevel } from './spoken.ts';
import { stripAudioTags } from './audioTags.ts';
import { repairArgs } from './toolInput.ts';
import { renderInline } from './markdown.ts';
import { detectLinks } from './links.ts';
import { resolveImage } from './showImage.ts';

const ok = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });

/**
 * Take back what a malformed tool call swallowed. See toolInput.ts — the model
 * occasionally writes the first parameter and then the REST OF THE CALL into one
 * string, which cost Danny a decision's options and put `</context><parameter…`
 * in his queue.
 *
 * Logged, never silent: a repair that leaves no trace is a model bug nobody ever
 * looks at again. It goes to the console rather than the transcript because it is
 * a curiosity about the call, not something that happened in the conversation.
 */
const repaired = <T extends Record<string, any>>(tool: string, args: T): T => {
  const { args: fixed, repaired: touched } = repairArgs(args);
  if (touched.length) console.warn(`  ⚠ ${tool}: malformed tool call, recovered ${touched.join(', ')}`);
  return fixed;
};

export function createHarnessTools(deps: {
  bus: ConversationBus;
  events: EventLog;
  pending: PendingStore;
  sessionId: () => string;
  publishPending: () => void;
  voiceActive: () => boolean;
  work: WorkIndex;
  repo: string;
  /**
   * Null when personal context is off — and then the tools are not REGISTERED at
   * all, rather than registered and refusing. Someone who turns this off is
   * saying don't keep a file on me, and a tool she can still see is a tool she
   * will still reach for.
   */
  personal: PersonalStore | null;
  /**
   * The speech level, as a dial she can turn herself. Narrow on purpose: the
   * tools have no business knowing about voice ids, held lines or ElevenLabs.
   */
  speech: SpeechControl;
}) {
  const links = (text: string) =>
    detectLinks(text, { repo: deps.repo, lookup: (p) => deps.work.byPath(p) });
  const say = tool(
    'say',
    'Deliver ONE discrete, announceable event to Danny: mid-work narration, a finding, an async announcement, or a direct answer. One item per call — call it again for the next item. The first sentence must stand alone (it may be heard, not read). `ref` is a plan path, commit sha, or event id.',
    {
      text: z.string().describe('One item. First sentence stands alone. No preamble, no bullet lists.'),
      kind: z.enum(['status', 'finding', 'event', 'answer']),
      ref: z.string().optional().describe('Plan path, commit sha, or event id this refers to.'),
    },
    async (raw) => {
      // A `say` whose text swallowed the next parameter would be READ ALOUD as
      // markup — the one place this failure is not merely ugly.
      const { text, kind, ref } = repaired('say', raw);
      const { text: read, spans } = renderInline(stripAudioTags(text));
      // `ref` is already a bare path — resolve it directly so the announcement's
      // own reference is the first thing that is clickable.
      deps.bus.publish({
        type: 'say',
        kind,
        text: read,
        spans,
        voiceText: text,
        ref,
        links: links(read),
        refLink: ref ? links(ref)[0] : undefined,
      });
      // The event log is a reading surface too — store the stripped form.
      deps.events.append({ source: 'harness', session: deps.sessionId(), kind: 'say', text: read, ref });
      return ok({ delivered: true, voiced: deps.voiceActive() });
    },
    { alwaysLoad: true }
  );

  /**
   * Her hand on the SCREEN — the visual counterpart of `say`. A tool rather
   * than markup in her prose, for the same reason links.ts refuses to make her
   * write link syntax: she is heard, and image markup is worse punctuation soup
   * than link markup. And mentioning a file is not the same act as showing one —
   * an auto-embedded mention would render a diagram three times because she
   * discussed it three times.
   *
   * The wire splits the way `speak` taught us: the figure replays with the
   * transcript (bus.ts), the pop does not, and the pop lands only on the tab
   * Danny is looking at (the speaker election in server.ts).
   */
  const show = tool(
    'show',
    'Put something on Danny\'s screen — the visual half of a spoken conversation. Pass `image` (a repo-relative path to a png/jpg/gif/webp/svg/avif that exists in the repo) to add a figure to the transcript; add `pop: true` when he should look NOW — it also opens large over the page he is looking at. Or pass `surface: "pending"` to open his pending queue full-size (natural when telling him what is waiting on him). Exactly one of `image` or `surface`. Nothing here is spoken — narrate it yourself: "here\'s the diagram".',
    {
      image: z.string().optional().describe('Repo-relative path to an image file in the bound repo.'),
      caption: z.string().optional().describe('One short line under the figure. Optional — your narration usually covers it.'),
      pop: z.boolean().optional().describe('Also open the image large over the page, on the tab Danny is looking at. For "look at this", not for every figure.'),
      surface: z.enum(['pending']).optional().describe('Open one of the page\'s own surfaces instead of an image.'),
    },
    async (raw) => {
      const { image, caption, pop, surface } = repaired('show', raw);
      if (Boolean(image) === Boolean(surface)) {
        return ok({ shown: false, reason: 'pass exactly one of image or surface' });
      }
      if (surface) {
        deps.bus.publish({ type: 'show', surface, pop: true });
        return ok({ shown: true, surface });
      }
      // Refuse BEFORE publishing: a broken <img> in the transcript tells Danny
      // less than this reason tells her.
      const proof = resolveImage(deps.repo, image!);
      if (!proof.ok) return ok({ shown: false, reason: proof.reason });
      deps.bus.publish({ type: 'show', image: { path: image!, caption }, pop: Boolean(pop) });
      deps.events.append({
        source: 'harness',
        session: deps.sessionId(),
        kind: 'show',
        text: caption ? `showed ${image} — ${caption}` : `showed ${image}`,
        ref: image,
      });
      return ok({ shown: true, popped: Boolean(pop) });
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
    async (raw) => {
      // Where this was found: the options were arriving inside `context`, so a
      // decision offered with four candidate answers reached the queue as free
      // text with markup on the end of it.
      const { title, context, options, plan, urgency } = repaired('queue_decision', raw);
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

  /**
   * The queue has to be CLEARABLE by her, or it only ever grows.
   *
   * Most queued decisions are not answered by clicking a button — they are
   * answered in conversation ("just park it"), or they stop mattering because the
   * work moved. Without a way to close one, the panel accumulates questions that
   * are already settled, and a queue you have learned to ignore is worse than no
   * queue: the one thing it is for is telling you what genuinely still waits.
   *
   * ⚠️ This does NOT send a turn back into the session the way `/api/resolve-
   * decision` does. That endpoint tells her what DANNY decided; this one is her
   * own hand, and echoing it back would be her talking to herself.
   */
  const closeDecision = tool(
    'close_decision',
    'Close a queued decision that is no longer waiting — he answered it in conversation, or it stopped mattering. Get the id from `pending`. Use this whenever a decision you queued has been settled some other way: an item he has already dealt with, still sitting in his queue, is how the queue stops being worth looking at. Do not use it to close something he has not actually decided.',
    {
      id: z.string().describe('The decision id, from `pending`.'),
      outcome: z
        .string()
        .describe('What was decided, or why it no longer applies. One line — it is what the event log will show.'),
    },
    async (raw) => {
      const { id, outcome } = repaired('close_decision', raw);
      const d = deps.pending.resolveDecision(id, outcome);
      if (!d) return ok({ closed: false, reason: 'no open decision with that id — call `pending` for the current ones' });
      deps.events.append({
        source: 'harness',
        session: deps.sessionId(),
        kind: 'decision_resolved',
        text: `${d.title} → ${outcome}`,
        ref: d.plan ?? d.id,
      });
      deps.publishPending();
      return ok({ closed: true, title: d.title });
    },
    { alwaysLoad: true }
  );

  /**
   * The other half of keeping the queue honest — see closeWorker in state.ts for
   * why a worker gets stuck in the first place.
   */
  const closeWorker = tool(
    'close_worker',
    'Drop a worker from the running roster when it is not running any more — it finished without reporting, you stopped it, or it belongs to a conversation that has since been cleared. Get the taskId from `pending`. ⚠ If `pending` lists workers you did not dispatch in this conversation, they are stale: clear them. A roster that says two things are running when nothing is makes the panel and the activity light lie about the whole session.',
    {
      taskId: z.string().describe('The worker taskId, from `pending`.'),
      note: z.string().describe('One line on what actually became of it.'),
    },
    async (raw) => {
      const { taskId, note } = repaired('close_worker', raw);
      const w = deps.pending.closeWorker(taskId, note);
      if (!w) return ok({ closed: false, reason: 'no running worker with that taskId — call `pending` for the current ones' });
      deps.events.append({
        source: 'harness',
        session: deps.sessionId(),
        kind: 'worker_done',
        text: `${w.description} cleared — ${note}`,
        ref: taskId,
      });
      deps.publishPending();
      return ok({ closed: true, description: w.description });
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
        .describe('in-flight = awaiting-eyes, active, blocked and planning. Use all only when explicitly asked about parked or shipped work.'),
      match: z.string().optional().describe('Filter to plans whose spoken name, title or path contains this.'),
      tasks: z.boolean().default(false).describe('Include the full task list per plan, not just counts. Verbose — ask for it only when the tasks themselves are the question.'),
    },
    async ({ scope, match, tasks }) => {
      const base = scope === 'all' ? deps.work.all() : deps.work.live();
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

  /**
   * "Stop talking" is a thing said OUT LOUD, mid-conversation, to the person
   * talking — not something Danny should have to reach for a dropdown to do. The
   * same dial the strip renders, with her hand on it too; the bus message
   * `setSpeechLevel` publishes is what keeps the two in step, so the select
   * follows her the same way it follows a click.
   *
   * ⚠ The change lands the moment the call does, and the level is read when a
   * message is PUBLISHED. So an acknowledgement written in the same message as
   * the call is spoken at the OLD level and one written after the tool result is
   * spoken at the NEW one — which is the right way round in both directions, but
   * only if she knows it. Hence the note in the description.
   */
  const speech = tool(
    'speech',
    'Set how much of what you write is READ ALOUD. This is Danny\'s dial and he asks for it out loud — "stop talking", "just the headlines", "you can talk again" — so turn it when he asks rather than promising to be briefer. The transcript is unaffected at every level: nothing is lost, it is only not pronounced. Omit `level` to read the current setting without changing it. The new level applies the moment this call lands, so put your one-line acknowledgement in the SAME reply as the call when you are going quieter, and in the reply AFTER it when you are turning speech back up.',
    {
      level: z
        .enum(SPEECH_LEVELS as [SpeechLevel, ...SpeechLevel[]])
        .optional()
        .describe(
          'full = every word you write, verbatim. brief = `say` items in full plus the last paragraph of anything longer (the usual setting). headlines = findings and announcements only, plus short one-line progress notes. off = silence; nothing is spoken at all.'
        ),
    },
    async ({ level }) => {
      const previous = deps.speech.level();
      if (!level || level === previous) return ok({ level: previous, changed: false });
      deps.speech.set(level);
      deps.events.append({
        source: 'harness',
        session: deps.sessionId(),
        kind: 'speech_level',
        text: `speech → ${level}`,
      });
      return ok({ level, previous, changed: true });
    },
    { alwaysLoad: true }
  );

  const remember = tool(
    'remember',
    'Note ONE thing about Danny himself that came up in passing — not about the work. A demo he is nervous about, how he likes to work, who someone is, a bad night. One item per call. Never interrogate him to fill this in, and never read it back to him.',
    {
      text: z.string().describe('One short fact, in your own words. "Demo for the tulito folks on Thursday — nervous about the geo pins."'),
      kind: z
        .enum(['thread', 'preference', 'state', 'fact'])
        .describe('thread = has an outcome you could ask about later; preference = how he likes to work; state = passing, for tone only; fact = durable and dull.'),
      due: z
        .string()
        .optional()
        .describe('THREAD ONLY. ISO date after which asking how it went would be welcome. Omit unless a follow-up is genuinely wanted.'),
    },
    async ({ text, kind, due }) => {
      const entry = deps.personal!.remember(kind as PersonalKind, text, due);
      return ok(entry ? { stored: true } : { stored: false });
    },
    { alwaysLoad: true }
  );

  const recall = tool(
    'recall',
    'Read back what you know about Danny personally. For your own use — to follow something up naturally, or to avoid asking what you already know. Never recite it to him.',
    {},
    async () => ok({ entries: deps.personal!.entries().slice(-40) }),
    { alwaysLoad: true }
  );

  return createSdkMcpServer({
    name: 'harness',
    version: '1.0.0',
    tools: [
      say,
      show,
      queueDecision,
      closeDecision,
      closeWorker,
      pending,
      plans,
      speech,
      ...(deps.personal ? [remember, recall] : []),
    ],
  });
}
