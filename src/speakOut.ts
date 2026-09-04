// The harness's adapter onto the mouth library — the counterpart of earHost.ts,
// and deliberately OUTSIDE src/mouth/, which is the liftable unit and must not
// know this harness exists.
//
// What lives here is everything conversation-shaped: the ONE subscription that
// IS the speech plane (she says a line because she wrote one — no turn to
// correlate with, no session to be inside), the speech LEVEL and its excerpting
// (spoken.ts — the page and the ear have different budgets), and every bus
// publish. The mouth itself — held lines, the TTS stream, voice resolution,
// tag stripping, the bill — is src/mouth/mouth.ts, with credentials injected
// and "there is a line to play" as one callback.
//
// The public surface is unchanged from when this WAS the whole plane: main.ts
// passes setVoice and speechLevel around by reference, and server.ts calls the
// rest. Behaviour changes here are a bug.
import type { HarnessConfig } from './config.ts';
import type { ConversationBus, UIMessage } from './bus.ts';
import type { VoiceRoom } from './voiceRoom.ts';
import { Mouth } from './mouth/mouth.ts';
import { spokenFor, spokenForDecision, spokenForHandoff, type SpeechLevel } from './spoken.ts';

export type { HeldLine } from './mouth/mouth.ts';

/**
 * How long a published line may go unreported before the stick stops waiting
 * for it. The page reports playback (`/api/voice/done`) and this almost never
 * fires; it exists for the tab that accepted a line and then closed, or never
 * existed. Generous on purpose — firing early releases the stick INTO a live
 * sentence, which is the inverted bug and inaudible as a bug.
 *
 * ⚠️ `chars` is the whole UNPLAYED queue, not one line: a line's clock starts
 * at publish but it plays at the back of the page's queue, and a tail line
 * sized only to itself expired while still waiting its turn — early release,
 * another beth over the top of live audio. Found by ear, reading lists.
 */
const backstopMs = (chars: number) => Math.min(120_000, 10_000 + chars * 70);

/**
 * How long the stick lingers once nothing is queued and nothing is playing.
 *
 * A thought is not over the moment a line ends: reading a list is short lines
 * with GENERATION gaps between them, and releasing into such a gap is how
 * another beth sneaks in mid-list (also found by ear). While her turn is in
 * flight more lines are plausibly coming, so the linger is long; once the turn
 * is over it is only the beat that covers the closing excerpt — and the turn
 * ending cuts a pending long linger down to the short one.
 */
const LINGER_BUSY_MS = 15_000;
const LINGER_IDLE_MS = 2_000;

export class SpeakOut {
  private mouth: Mouth;
  private bus: ConversationBus;
  /** How much of what she writes is read aloud. See spoken.ts. */
  private verbosity: SpeechLevel;
  /** The machine's shared voice room. Absent means uncoordinated — today's old behaviour. */
  private room: VoiceRoom | null;
  /**
   * Whether any page is connected — the server supplies the real answer. True
   * by default so a line published before the server wires this up still
   * coordinates rather than slipping past the stick.
   */
  private audience: () => boolean = () => true;
  /** Lines waiting on the stick, in the order she said them. */
  private queue: { id: string; chars: number }[] = [];
  /** Published lines the page has not yet reported played, with backstops. */
  private awaiting = new Map<string, { timer: ReturnType<typeof setTimeout> | null; chars: number }>();
  private holding = false;
  private waiting = false;
  /** Whether her turn is in flight — the signal that more lines are coming. */
  private turnBusy = false;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  /** Lines asked for by a click, which the mute does not reach. */
  private explicit = new Set<string>();
  /** True only for the synchronous span of an explicit `speak()`. */
  private explicitNext = false;

  /**
   * Was this line ASKED for?
   *
   * ⚠️ Both halves are needed and they cover different moments. `explicitNext`
   * covers the synchronous span inside `speak()`, where the id is not yet
   * registered because `mouth.speak` calls back before it returns; the set
   * covers everything after, where a line can sit on the stick for seconds.
   * Checking only one drops the reread on a muted machine — silently, since a
   * click that plays nothing is indistinguishable from a click that missed.
   */
  private isExplicit(id: string) {
    return this.explicitNext || this.explicit.has(id);
  }
  /** Injectable so the backstop and linger paths are testable in milliseconds. */
  private backstop: (chars: number) => number;
  private linger: (turnBusy: boolean) => number;

  constructor(
    cfg: HarnessConfig,
    bus: ConversationBus,
    room?: VoiceRoom,
    opts?: { backstopMs?: (chars: number) => number; lingerMs?: (turnBusy: boolean) => number }
  ) {
    this.bus = bus;
    this.room = room ?? null;
    this.backstop = opts?.backstopMs ?? backstopMs;
    this.linger = opts?.lingerMs ?? ((busy) => (busy ? LINGER_BUSY_MS : LINGER_IDLE_MS));
    this.verbosity = cfg.speechLevel;
    this.mouth = new Mouth(
      {
        apiKey: cfg.elevenLabsApiKey,
        voiceId: cfg.voiceId,
        speechEngineId: cfg.speechEngineId,
        ttsModel: cfg.ttsModel,
        usdPer1kCredits: cfg.ttsUsdPer1kCredits,
      },
      // The page only needs the id; `chars` lets it show progress without
      // shipping the line twice, since the transcript already carries the words.
      // Between the mouth and the bus sits the ROOM: the publish is what makes
      // a tab play, so the machine's talking stick is taken there.
      (line) => this.onLine(line)
    );

    // The whole speech plane is this subscription. There is no turn to correlate
    // with, no session to be inside, and no in-flight response to avoid racing:
    // she says a line because she wrote one.
    bus.subscribe((m: UIMessage) => {
      // The turn state feeds the linger: mid-turn, a drained stick is a pause;
      // after it, only the closing excerpt can still be coming.
      if (m.type === 'status') {
        this.turnBusy = m.state === 'thinking';
        if (!this.turnBusy && this.releaseTimer) {
          clearTimeout(this.releaseTimer);
          this.releaseTimer = null;
          this.maybeRelease();
        }
        return;
      }
      // A decision ARRIVING is a summons, and it used to be the only thing on
      // this bus that was never spoken. `pending` carries the whole list and
      // fires for unrelated reasons (a worker started, a worker finished), so
      // what counts is an id we have not seen — not the message.
      if (m.type === 'pending') return void this.announceDecisions(m.decisions);
      // A hand-off arriving is the other summons (inbox.ts). main.ts publishes
      // the event ONCE per new id, seeded from the boot read, so unlike
      // `pending` the message itself is the trigger — and the backlog is never
      // read aloud, because no event is published for it.
      if (m.type === 'event') {
        if (m.event.kind !== 'handoff' || this.room?.muted()) return;
        const from = m.event.text.split(':')[0]?.trim() || 'the inbox';
        const title = m.event.text.slice(m.event.text.indexOf(':') + 1).trim();
        return void this.mouth.speak(spokenForHandoff({ from, title }, this.verbosity));
      }
      if (m.type !== 'assistant' && m.type !== 'say') return;
      // The universal mute gates HERE, before the line is even held: never
      // announced, never fetched, never billed — consistent with counting the
      // bill at stream(). Direct speak() bypasses it on purpose: the reread
      // click is an explicit request, the same rule that lets it speak at
      // level 'off'. Nothing suppressed here replays on unmute — news that has
      // passed, the same reasoning as the mouth's own hold window.
      if (this.room?.muted()) return;
      this.mouth.speak(
        spokenFor({ type: m.type, kind: m.type === 'say' ? m.kind : undefined, text: m.voiceText ?? m.text }, this.verbosity)
      );
    });
  }

  /**
   * Decision ids already announced.
   *
   * ⚠️ SEEDED from the first `pending` rather than started empty: the store
   * restores decisions across a restart and publishes them, so an empty set
   * would read Danny his whole backlog aloud every time the harness came up —
   * which is exactly the noise that teaches you to mute it.
   */
  private seenDecisions: Set<string> | null = null;

  private announceDecisions(decisions: Array<{ id: string; title: string; urgency?: string }>) {
    if (this.seenDecisions === null) {
      this.seenDecisions = new Set(decisions.map((d) => d.id));
      return;
    }
    if (this.room?.muted()) {
      // Still mark them seen: unmuting replays nothing here either, same as the
      // line filter above — news that has passed.
      for (const d of decisions) this.seenDecisions.add(d.id);
      return;
    }
    for (const d of decisions) {
      if (this.seenDecisions.has(d.id)) continue;
      this.seenDecisions.add(d.id);
      this.mouth.speak(spokenForDecision(d, this.verbosity));
    }
  }

  /** The server's live answer to "is any page connected". */
  setAudience(fn: () => boolean) {
    this.audience = fn;
  }

  private onLine(line: { id: string; chars: number }) {
    // ⚠️ The mute is checked AGAIN here, not only at the subscription. The two
    // are far apart in time: the subscription gate runs when she writes, and a
    // line then waits — for the TTS request, and for the talking stick, which
    // can block for as long as another beth is mid-sentence. Danny muted and
    // still heard a line, because it had already passed the only gate there was.
    if (this.room?.muted() && !this.isExplicit(line.id)) return;
    // No room, or no page connected: publish straight through. With no
    // audience nothing will play, and taking the stick would let a boot with
    // no tab yet (the greeting races the browser opening) silence every other
    // beth for the length of the backstop.
    if (!this.room || !this.audience()) {
      this.bus.publish({ type: 'speak', id: line.id, chars: line.chars });
      return;
    }
    this.queue.push(line);
    this.pump();
  }

  private pump() {
    // The last gate, and the one that catches a mute landing DURING a wait —
    // `acquire()` resolves into here, so a line that queued before the mute and
    // won the stick after it would otherwise publish as if nothing happened.
    // Dropped rather than deferred: unmuting replays nothing, because by then
    // it is news that has passed. Never fetched, so never billed.
    if (this.room?.muted()) this.dropQueued();
    if (!this.queue.length || this.waiting) return;
    // A new line lands inside the linger: the thought continues on the same hold.
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    if (!this.holding) {
      if (!this.room!.tryAcquire()) {
        this.waiting = true;
        void this.room!.acquire().then(() => {
          this.waiting = false;
          this.holding = true;
          this.pump();
        });
        return;
      }
      this.holding = true;
    }
    while (this.queue.length) {
      const line = this.queue.shift()!;
      this.bus.publish({ type: 'speak', id: line.id, chars: line.chars });
      // Sized to everything unplayed AHEAD of it plus itself — see backstopMs.
      let unplayed = line.chars;
      for (const a of this.awaiting.values()) unplayed += a.chars;
      const entry = { timer: null as ReturnType<typeof setTimeout> | null, chars: line.chars };
      entry.timer = this.startBackstop(line.id, unplayed);
      this.awaiting.set(line.id, entry);
    }
  }

  private startBackstop(id: string, chars: number) {
    const t = setTimeout(() => this.playbackDone([id], { fromBackstop: true }), this.backstop(chars));
    t.unref?.();
    return t;
  }

  /**
   * The page (or the backstop) reports lines finished — played, refused, or
   * dropped by a stop. Unknown ids are harmless: a reloaded page may report a
   * line whose backstop already cleared it.
   *
   * A PAGE report is also proof of liveness, so the remaining backstops restart
   * — the page is playing, just not up to those lines yet. A backstop firing
   * proves nothing and restarts nothing: on a dead tab the timers must burn
   * down once each, not feed each other.
   */
  playbackDone(ids: string[], opts?: { fromBackstop?: boolean }) {
    // Done is done: the bypass was for getting it played, not a standing pass.
    this.forget(ids);
    for (const id of ids) {
      const a = this.awaiting.get(id);
      if (a?.timer) clearTimeout(a.timer);
      this.awaiting.delete(id);
    }
    if (!opts?.fromBackstop && this.awaiting.size) {
      let unplayed = 0;
      for (const [id, a] of this.awaiting) {
        unplayed += a.chars;
        if (a.timer) clearTimeout(a.timer);
        a.timer = this.startBackstop(id, unplayed);
      }
    }
    this.maybeRelease();
  }

  /**
   * The stick is held for the whole THOUGHT — released only when nothing is
   * queued, nothing published is still playing, and the linger has passed.
   * Per-line release would interleave three beths paragraph by paragraph, and
   * releasing at the instant of drain lost the floor in the writing gaps
   * between a list's short lines — both worse than the overlap this fixes.
   */
  private maybeRelease() {
    if (!this.holding || this.queue.length || this.awaiting.size) return;
    const ms = this.linger(this.turnBusy);
    if (ms <= 0) return this.releaseNow();
    if (this.releaseTimer) return;
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      if (this.holding && !this.queue.length && !this.awaiting.size) this.releaseNow();
    }, ms);
    this.releaseTimer.unref?.();
  }

  /**
   * Throw away what was queued and let the floor go.
   *
   * ⚠️ Must release: the stick is machine-wide, so holding it for lines nobody
   * will ever hear is how a mute on THIS harness silences the other two — the
   * same class of bug as a page that ends a line without reporting it.
   */
  private forget(ids: string[]) {
    for (const id of ids) this.explicit.delete(id);
  }

  private dropQueued() {
    // A clicked line is kept: the mute is about what she volunteers, and this
    // was asked for. Everything else goes.
    this.queue = this.queue.filter((l) => this.isExplicit(l.id));
    if (this.queue.length) return;
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    // Anything already published is the page's to finish; its own stop() reports
    // those back, which is what clears `awaiting` and releases from there.
    if (this.holding && !this.awaiting.size) this.releaseNow();
  }

  private releaseNow() {
    this.holding = false;
    this.room?.release();
  }

  speechLevel = () => this.verbosity;

  setSpeechLevel(level: SpeechLevel) {
    this.verbosity = level;
    this.bus.publish({ type: 'speech', level });
  }

  // --- the mouth, delegated ---------------------------------------------------
  // Arrow properties where main.ts passes the method around by reference.

  get configured() {
    return this.mouth.configured;
  }

  get unavailableReason() {
    return this.mouth.unavailableReason;
  }

  get lastError() {
    return this.mouth.lastError;
  }

  /**
   * Say this, because someone clicked. Bypasses the mute on purpose — the same
   * rule that lets a reread speak at level `off`: an explicit request is not
   * ambience. The stick still applies; explicit is not a licence to overlap.
   *
   * ⚠️ The id is REMEMBERED, because the mute is re-checked further down the
   * pipe now (a held line can outlive the mute that should have stopped it) and
   * those checks cannot otherwise tell this line from one she simply wrote.
   */
  speak(raw: string): string | null {
    // ⚠️ The flag is set BEFORE the call, not after: `mouth.speak` invokes
    // `onLine` synchronously, so there is no id to register until it has already
    // been through every gate below. The id is recorded too, for the gates that
    // run later — the stick can hold a line long after this returns.
    this.explicitNext = true;
    try {
      const id = this.mouth.speak(raw);
      if (id) this.explicit.add(id);
      return id;
    } finally {
      this.explicitNext = false;
    }
  }

  textFor(id: string): string | null {
    return this.mouth.textFor(id);
  }

  stream(id: string): Promise<ReadableStream<Uint8Array>> {
    return this.mouth.stream(id);
  }

  setVoice = (voiceId: string | null) => this.mouth.setVoice(voiceId);

  currentVoice = () => this.mouth.currentVoice();

  spend() {
    return this.mouth.spend();
  }

  status() {
    return this.mouth.status();
  }
}
