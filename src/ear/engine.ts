// The ear as a LIBRARY — the engine interface everything else compiles against.
//
// This directory is the liftable unit (see docs/ear.md): no imports from the
// harness, credentials and callbacks injected, so another project copies the
// directory and brings its own adapter. The harness's own adapter is
// src/earHost.ts, deliberately outside.

/** A recogniser that can be fed audio and says what it heard. */
export interface EarEngine {
  /** Open one live recognition session. The caller owns its lifetime. */
  start(opts: EarSessionOpts): EarSession;
}

export type EarState = 'starting' | 'live' | 'degraded' | 'closed';

export interface EarSessionOpts {
  /**
   * Plain nouns to bias toward; the engine delivers them however it can.
   * Engines enforce their own hard limits (Scribe: ≤50 terms, ≤20 chars each)
   * and REPORT what they drop — a silently truncated vocabulary looks exactly
   * like biasing not working.
   */
  keyterms?: string[];
  /** Best guess so far, punctuated. Replaced, not appended, on each call. */
  onPartial: (text: string) => void;
  /** The engine heard the utterance end. One utterance, one call. */
  onCommit: (text: string) => void;
  /**
   * `degraded` is the fallback signal, not an error: quota, throttle and
   * outage all mean "listen another way", never "the mic is dead".
   */
  onState: (state: EarState, detail?: string) => void;
  /**
   * Called with seconds of audio actually forwarded to the recogniser — the
   * moment of spend, for engines that bill. Parked audio never reaches this.
   */
  onAudioForwarded?: (seconds: number) => void;
}

export interface EarSession {
  /** 16 kHz mono PCM. Safe to call before the transport is up; audio queues. */
  push(pcm: Int16Array): void;
  /**
   * Drop the utterance in flight WITHOUT closing the session.
   *
   * The guarantee: nothing already heard may surface as a commit afterwards —
   * and nothing said later may be swallowed. An abandon with nothing in
   * flight is a no-op, not a debt against the next sentence.
   */
  abandon(): void;
  close(): Promise<void>;
}
