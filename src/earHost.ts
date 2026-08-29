// The harness's adapter onto the ear library — deliberately OUTSIDE src/ear/,
// which is the liftable unit and must not know this harness exists.
//
// What lives here is everything project-shaped: the ONE-EAR rule (mirror of
// "one mouth, however many tabs" — two armed tabs would be two paid sessions
// transcribing the same room, so the newest armer wins and the loser is told),
// the vocabulary assembly, publication onto the conversation bus, and the
// bill. The engine is injected so tests never open a websocket.
import type { UIMessage } from './bus.ts';
import type { EarEngine, EarSession } from './ear/engine.ts';

export class EarHost {
  private engine: EarEngine | null;
  private unavailable: string | null;
  private vocabulary: () => string[];
  private publish: (m: UIMessage) => void;
  private session: EarSession | null = null;
  private ownerId = 0;
  private seconds = 0;
  private usdPerHour: number;

  constructor(deps: {
    /** null when voice is absent — the ear degrades to "not offered". */
    engine: EarEngine | null;
    /** Why the engine is null, said to the page instead of a dead button. */
    unavailable?: string;
    /** Assembled per arm, not at boot — live plan names are half of it. */
    vocabulary: () => string[];
    publish: (m: UIMessage) => void;
    usdPerHour: number;
  }) {
    this.engine = deps.engine;
    this.unavailable = deps.unavailable ?? null;
    this.vocabulary = deps.vocabulary;
    this.publish = deps.publish;
    this.usdPerHour = deps.usdPerHour;
  }

  owner(): number {
    return this.session ? this.ownerId : 0;
  }

  arm(streamId: number): { ok: boolean; reason?: string } {
    if (!this.engine) return { ok: false, reason: this.unavailable ?? 'no ear engine' };
    if (this.session) {
      if (this.ownerId === streamId) return { ok: true };
      // The steal. Close the old session and SAY so on the old owner's ear —
      // a mic that silently went dead in the other tab reads as a hang.
      const old = this.session;
      const oldOwner = this.ownerId;
      this.session = null;
      void old.close();
      this.publish({ type: 'ear', state: 'off', owner: oldOwner, detail: 'the mic moved to another tab' });
    }
    const owner = streamId;
    this.ownerId = owner;
    const session = this.engine.start({
      keyterms: this.vocabulary(),
      onPartial: (text) => this.session === session && this.publish({ type: 'ear', state: 'partial', text, owner }),
      onCommit: (text) => this.session === session && this.publish({ type: 'ear', state: 'commit', text, owner }),
      onState: (state, detail) => {
        if (this.session !== session) return;
        if (state === 'live') this.publish({ type: 'ear', state: 'live', owner, detail });
        if (state === 'degraded') {
          // The session is spent; drop it so the next arm starts fresh. The
          // page hears WHY and decides what "listen another way" means.
          this.session = null;
          this.publish({ type: 'ear', state: 'degraded', owner, detail });
        }
      },
      // The moment of spend: seconds counted when audio is FORWARDED to the
      // engine. Parked audio never leaves the page, so it never lands here.
      onAudioForwarded: (s) => (this.seconds += s),
    });
    this.session = session;
    return { ok: true };
  }

  disarm(streamId: number) {
    if (!this.session || this.ownerId !== streamId) return;
    const s = this.session;
    this.session = null;
    void s.close();
  }

  /** Audio from the page. Only the owner's; a straggler tab's parcels drop. */
  audio(streamId: number, pcm: Int16Array) {
    if (!this.session || this.ownerId !== streamId) return;
    this.session.push(pcm);
  }

  abandon(streamId: number) {
    if (!this.session || this.ownerId !== streamId) return;
    this.session.abandon();
  }

  /**
   * The other other bill. Seconds are exact — counted at forwarding, the
   * moment Scribe meters — and the dollars are an estimate, so the assumed
   * rate rides along to be printed beside the number, never behind it.
   */
  spend(): { seconds: number; usd: number; usdPerHour: number } {
    return {
      seconds: Math.round(this.seconds),
      usd: (this.seconds / 3600) * this.usdPerHour,
      usdPerHour: this.usdPerHour,
    };
  }
}
