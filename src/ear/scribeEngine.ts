// ElevenLabs Scribe v2 realtime, behind the EarEngine interface.
//
// Everything here was measured against the real service before it was written
// down — the frames in fixtures/ are captured verbatim, not invented. See
// spike/ear/README.md for the findings this encodes:
//
//   - Auth is a SINGLE-USE TOKEN minted over HTTPS and passed as `?token=`,
//     which is why node's native WebSocket suffices and `ws` stays deleted.
//     The API key never meets a websocket URL.
//   - Keyterms ride as REPEATED query params. A term over 20 chars is FATAL to
//     the session (`invalid_request`, close 1008), not a warning — so they are
//     filtered here, and what falls is reported, never dropped silently.
//   - Errors arrive as typed FRAMES after a successful socket open. `open`
//     means transport; `session_started` is the go signal.
import type { EarEngine, EarSession, EarSessionOpts } from './engine.ts';

export interface ScribeEngineConfig {
  apiKey: string;
  /** Override for tests and regional endpoints. */
  apiOrigin?: string;
  wsOrigin?: string;
  modelId?: string;
  /** Seconds of silence before a VAD commit. Absent means Scribe's default (1.5). */
  vadSilenceSecs?: number;
  /** Drop filler words and false starts. */
  noVerbatim?: boolean;
  /** Injected for tests; defaults to the globals. */
  fetchFn?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocket;
}

/** Scribe's own hard limits, learned the fatal way in the spike. */
export const MAX_KEYTERMS = 50;
export const MAX_KEYTERM_CHARS = 20;

const SAMPLE_RATE = 16_000;

export class ScribeEngine implements EarEngine {
  private cfg: ScribeEngineConfig;

  constructor(cfg: ScribeEngineConfig) {
    this.cfg = cfg;
  }

  start(opts: EarSessionOpts): EarSession {
    return new ScribeSession(this.cfg, opts);
  }
}

class ScribeSession implements EarSession {
  private cfg: ScribeEngineConfig;
  private opts: EarSessionOpts;
  private ws: WebSocket | null = null;
  private state: 'starting' | 'live' | 'degraded' | 'closed' = 'starting';
  /** Audio pushed before the socket opened. Bounded: ~10s, then oldest drops. */
  private queue: Int16Array[] = [];
  private static QUEUE_MAX = 40;
  private socketOpen = false;
  private closeRequested = false;
  private closed: Promise<void>;
  private resolveClosed!: () => void;
  /**
   * Abandon, Scribe-shaped. The service holds the utterance server-side, so
   * "drop it" means swallowing what it goes on to say about audio already
   * sent: partials, and the ONE commit that closes that utterance. Armed only
   * when something is actually in flight — an abandon with nothing heard must
   * not eat the NEXT sentence.
   */
  private discardUntilCommit = false;
  private heardSinceCommit = false;

  constructor(cfg: ScribeEngineConfig, opts: EarSessionOpts) {
    this.cfg = cfg;
    this.opts = opts;
    this.closed = new Promise((r) => (this.resolveClosed = r));
    void this.open();
  }

  private fail(detail: string) {
    if (this.state === 'degraded' || this.state === 'closed') return;
    this.state = 'degraded';
    this.opts.onState('degraded', detail);
  }

  private async open() {
    const f = this.cfg.fetchFn ?? fetch;
    const api = this.cfg.apiOrigin ?? 'https://api.elevenlabs.io';
    let token: string;
    try {
      const res = await f(`${api}/v1/single-use-token/realtime_scribe`, {
        method: 'POST',
        headers: { 'xi-api-key': this.cfg.apiKey },
      });
      const body = await res.text();
      if (!res.ok) {
        // 401/403 here is the missing speech_to_text permission — one checkbox,
        // so the reason must survive to somewhere Danny can read it.
        this.fail(`token mint refused (HTTP ${res.status}): ${body.slice(0, 200)}`);
        this.resolveClosed();
        return;
      }
      token = JSON.parse(body).token;
      if (!token) throw new Error(`no token field in ${body.slice(0, 100)}`);
    } catch (e) {
      this.fail(`token mint failed: ${String(e).slice(0, 200)}`);
      this.resolveClosed();
      return;
    }
    if (this.closeRequested) return this.resolveClosed();

    const params = new URLSearchParams({
      model_id: this.cfg.modelId ?? 'scribe_v2_realtime',
      token,
      audio_format: `pcm_${SAMPLE_RATE}`,
      commit_strategy: 'vad',
    });
    if (this.cfg.vadSilenceSecs) params.set('vad_silence_threshold_secs', String(this.cfg.vadSilenceSecs));
    if (this.cfg.noVerbatim) params.set('no_verbatim', 'true');
    const { kept, dropped } = filterKeyterms(this.opts.keyterms ?? []);
    for (const k of kept) params.append('keyterms', k);
    if (dropped.length) {
      // Not silent: a vocabulary that quietly shrank looks exactly like biasing
      // not working, which is the same invisibility keyterms exist to fight.
      this.opts.onState(this.state === 'starting' ? 'starting' : this.state, `keyterms dropped (Scribe limits): ${dropped.join(', ')}`);
    }

    const make = this.cfg.webSocketFactory ?? ((u: string) => new WebSocket(u));
    let ws: WebSocket;
    try {
      ws = make(`${this.cfg.wsOrigin ?? 'wss://api.elevenlabs.io'}/v1/speech-to-text/realtime?${params}`);
    } catch (e) {
      this.fail(`websocket failed to construct: ${String(e).slice(0, 200)}`);
      this.resolveClosed();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      // Transport only. The go signal is the session_started FRAME — a bad
      // token opens cleanly and then says auth_error (captured in fixtures).
      this.socketOpen = true;
      for (const chunk of this.queue.splice(0)) this.send(chunk);
    });
    ws.addEventListener('message', (ev) => this.onFrame(String((ev as MessageEvent).data)));
    ws.addEventListener('error', () => this.fail('websocket error'));
    ws.addEventListener('close', (ev) => {
      const { code, reason } = ev as CloseEvent;
      if (!this.closeRequested && this.state !== 'degraded') {
        this.fail(`connection closed (${code}${reason ? ` ${reason}` : ''})`);
      }
      if (this.state !== 'closed') this.state = 'closed';
      this.opts.onState('closed');
      this.resolveClosed();
    });
  }

  private onFrame(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.message_type) {
      case 'session_started':
        if (this.state === 'starting') {
          this.state = 'live';
          this.opts.onState('live');
        }
        return;
      case 'partial_transcript': {
        const text = String(msg.text ?? '');
        if (this.discardUntilCommit) return;
        if (text) this.heardSinceCommit = true;
        this.opts.onPartial(text);
        return;
      }
      case 'committed_transcript':
      case 'committed_transcript_with_timestamps': {
        // With timestamps enabled Scribe sends both forms for one utterance;
        // only the bare one is treated as THE commit to keep that path single.
        if (msg.message_type !== 'committed_transcript') return;
        const text = String(msg.text ?? '');
        if (this.discardUntilCommit) {
          // The swallowed commit closes the abandoned utterance; the session
          // is clean again from here.
          this.discardUntilCommit = false;
          this.heardSinceCommit = false;
          return;
        }
        this.heardSinceCommit = false;
        if (text.trim()) this.opts.onCommit(text);
        return;
      }
      default: {
        // Everything else typed is the error taxonomy: auth_error,
        // quota_exceeded, rate_limited, invalid_request, … — all of them mean
        // "listen another way", carried as degraded with the service's reason.
        if (typeof msg.message_type === 'string' && (msg.error || /error|exceeded|limited|invalid/.test(msg.message_type))) {
          this.fail(`${msg.message_type}${msg.error ? `: ${msg.error}` : ''}`);
        }
      }
    }
  }

  private send(pcm: Int16Array) {
    this.ws!.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'),
        sample_rate: SAMPLE_RATE,
        commit: false,
      })
    );
    this.opts.onAudioForwarded?.(pcm.length / SAMPLE_RATE);
  }

  push(pcm: Int16Array) {
    if (this.state === 'degraded' || this.state === 'closed' || this.closeRequested) return;
    if (!this.socketOpen) {
      this.queue.push(pcm);
      if (this.queue.length > ScribeSession.QUEUE_MAX) this.queue.shift();
      return;
    }
    this.send(pcm);
  }

  abandon() {
    if (!this.heardSinceCommit) return;
    this.discardUntilCommit = true;
  }

  async close() {
    this.closeRequested = true;
    this.queue.length = 0;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      try {
        this.ws.close(1000);
      } catch {
        this.resolveClosed();
      }
    } else {
      this.resolveClosed();
    }
    // A socket that never answers the close must not wedge the caller.
    await Promise.race([this.closed, new Promise((r) => setTimeout(r, 3000))]);
  }
}

/** Scribe's limits, applied loudly. Exported for the tests and the adapter. */
export function filterKeyterms(terms: string[]): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const t of terms) {
    if (t.length <= MAX_KEYTERM_CHARS && kept.length < MAX_KEYTERMS && t.trim()) kept.push(t);
    else dropped.push(t);
  }
  return { kept, dropped };
}
