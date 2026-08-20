// The wire tap — what actually happens, kept until somebody asks.
//
// The SDK's message stream IS the LLM back-and-forth: every assistant message
// (one per API request, usage attached), every tool result going back, thinking
// blocks, compaction boundaries, retries. `session.ts` consumes three of those
// types and drops the rest; this records a compact form of ALL of them so the
// wire panel can show a turn's anatomy — requests, tokens, thinking, tools,
// time — after the fact.
//
// ⚠️ NOTHING here touches the bus. The bus replays history to every connecting
// page, and wire traffic would bloat both. This is a ring buffer the panel
// PULLS from (`GET /api/wire?since=`) while it is open — a closed panel costs
// zero broadcast, zero render, and a bounded slice of memory.
//
// Previews are truncated at capture, not at render: a test run's 2MB of output
// must never sit in the buffer 500 times. The full size is recorded beside the
// preview, because "how big was it" is half of what the panel teaches.

/** One thing that happened on the wire, in the order it happened. */
export type WireEntry = {
  seq: number;
  ts: number;
  /** The conversational turn this belongs to — session.turnSeq at the time. */
  turn: number;
} & (
  | { kind: 'user'; text: string }
  | {
      kind: 'request';
      /** The API message id — one assistant message is one API response. */
      id: string;
      model: string;
      /** Milliseconds from request start to first streamed token, SDK-stamped. */
      ttftMs?: number;
      /** When the request started (last activity before it) and finished. */
      startAt: number;
      /** Content block boundaries, for the anatomy strip. */
      blocks: { type: 'thinking' | 'text' | 'tool_use'; at: number }[];
      usage: { in: number; cacheW: number; cacheR: number; out: number };
      thinking: string[];
      text: string[];
      tools: { name: string; input: string }[];
    }
  | { kind: 'tool_result'; bytes: number; preview: string; isError: boolean; sinceMs: number }
  | {
      kind: 'result';
      durationMs: number;
      apiMs: number;
      requests: number;
      cost: number;
      usage: { in: number; cacheR: number; out: number };
      isError: boolean;
    }
  | { kind: 'event'; label: string; detail?: string }
);

const CAP = 800;
const PREVIEW = 400;

const excerpt = (s: string, n = PREVIEW) => (s.length > n ? `${s.slice(0, n)}…` : s);

export class WireTap {
  private entries: WireEntry[] = [];
  private seq = 0;
  private turn = 0;
  /** When the in-flight API request started: the last moment anything happened. */
  private lastAt: number;
  /** Block boundaries seen via stream events for the request in flight. */
  private pendingBlocks: { type: 'thinking' | 'text' | 'tool_use'; at: number }[] = [];
  private pendingTtft: number | undefined;
  private requestStartAt: number;
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.lastAt = now();
    this.requestStartAt = now();
  }

  private push(e: Omit<WireEntry, 'seq' | 'ts' | 'turn'> & { ts?: number }) {
    this.entries.push({ seq: ++this.seq, ts: e.ts ?? this.now(), turn: this.turn, ...e } as WireEntry);
    if (this.entries.length > CAP) this.entries.splice(0, this.entries.length - CAP);
  }

  /** A turn Danny started. Called from send(), which every input path goes through. */
  userTurn(turn: number, text: string) {
    this.turn = turn;
    this.lastAt = this.now();
    this.requestStartAt = this.lastAt;
    this.push({ kind: 'user', text: excerpt(text, 200) });
  }

  /**
   * Every SDK message, including all the types session.ts does not act on.
   * Compact at capture; the panel gets summaries, never raw payloads.
   */
  record(m: any) {
    switch (m.type) {
      case 'stream_event': {
        // Deltas are a token-rate flood; what the anatomy strip needs is only
        // WHERE the block boundaries fell, and the SDK's own ttft stamp.
        if (typeof m.ttft_ms === 'number') this.pendingTtft ??= m.ttft_ms;
        const e = m.event;
        if (e?.type === 'message_start') this.requestStartAt = this.lastAt;
        if (e?.type === 'content_block_start') {
          const t = e.content_block?.type;
          if (t === 'thinking' || t === 'text' || t === 'tool_use') this.pendingBlocks.push({ type: t, at: this.now() });
        }
        return;
      }
      case 'assistant': {
        const msg = m.message ?? {};
        const u = msg.usage ?? {};
        const thinking: string[] = [];
        const text: string[] = [];
        const tools: { name: string; input: string }[] = [];
        for (const b of msg.content ?? []) {
          if (b.type === 'thinking' && b.thinking) thinking.push(excerpt(String(b.thinking), 160));
          else if (b.type === 'text' && b.text?.trim()) text.push(excerpt(b.text.trim(), 200));
          else if (b.type === 'tool_use') tools.push({ name: String(b.name), input: excerpt(JSON.stringify(b.input ?? {}), 160) });
        }
        this.push({
          kind: 'request',
          id: String(msg.id ?? ''),
          model: String(msg.model ?? ''),
          ttftMs: this.pendingTtft,
          startAt: this.requestStartAt,
          blocks: this.pendingBlocks,
          usage: {
            in: u.input_tokens ?? 0,
            cacheW: u.cache_creation_input_tokens ?? 0,
            cacheR: u.cache_read_input_tokens ?? 0,
            out: u.output_tokens ?? 0,
          },
          thinking,
          text,
          tools,
        });
        this.pendingBlocks = [];
        this.pendingTtft = undefined;
        this.lastAt = this.now();
        this.requestStartAt = this.lastAt;
        return;
      }
      case 'user': {
        // Tool results riding back. Our OWN turns also echo through here as
        // replays; those carry plain string content and are already recorded at
        // send() — only block arrays with tool_result entries are wire traffic.
        const content = m.message?.content;
        if (!Array.isArray(content)) return;
        for (const b of content) {
          if (b.type !== 'tool_result') continue;
          const raw = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
          this.push({
            kind: 'tool_result',
            bytes: raw.length,
            preview: excerpt(raw),
            isError: Boolean(b.is_error),
            sinceMs: this.now() - this.lastAt,
          });
        }
        this.lastAt = this.now();
        this.requestStartAt = this.lastAt;
        return;
      }
      case 'result': {
        const u = m.usage ?? {};
        this.push({
          kind: 'result',
          durationMs: m.duration_ms ?? 0,
          apiMs: m.duration_api_ms ?? 0,
          requests: m.num_turns ?? 0,
          cost: m.total_cost_usd ?? 0,
          usage: { in: u.input_tokens ?? 0, cacheR: u.cache_read_input_tokens ?? 0, out: u.output_tokens ?? 0 },
          isError: Boolean(m.is_error),
        });
        this.lastAt = this.now();
        return;
      }
      case 'system': {
        // init is boot noise; a compaction boundary is exactly the kind of
        // invisible event the panel exists to make visible.
        if (m.subtype === 'compact_boundary') {
          this.push({
            kind: 'event',
            label: 'context compacted',
            detail: m.compact_metadata ? `${m.compact_metadata.trigger}, ${m.compact_metadata.pre_tokens} tokens before` : undefined,
          });
        }
        return;
      }
      default: {
        // Retries, rate-limit events, refusal fallbacks — surfaced by name so
        // the exchange shows they happened, without modeling each one.
        if (/retry|rate_limit|refusal/.test(String(m.type))) {
          this.push({ kind: 'event', label: String(m.type).replace(/_/g, ' ') });
        }
      }
    }
  }

  /** Everything after `since`, plus the cursor for the next poll. */
  read(since = 0): { seq: number; entries: WireEntry[] } {
    return { seq: this.seq, entries: since ? this.entries.filter((e) => e.seq > since) : [...this.entries] };
  }
}
