// The last line of the terminal: `beth: <repo>` with a spinner while a turn is
// in flight, nothing more. It exists because a `beth` running in a tab looks
// identical whether she is mid-turn or has been idle for an hour, and the only
// way to tell was the browser.
//
// The line is REDRAWN, not printed: `\r` back to column 0, clear, write, no
// newline — so it stays put at the bottom while everything else scrolls above
// it. That is only true if everything else goes through here: a plain
// `console.log` from another module would land on top of the status text and
// leave the tail of it on the same row. So `install()` wraps the console's
// three writers to clear the line, print, and redraw. Wrapping the console
// rather than routing every module through a logger is deliberate: the rest of
// the harness keeps its ~25 `console.log` calls untouched, and a module that is
// lifted out of the harness (the ear, the mouth) has nothing to unlearn.
//
// ⚠ Not a TTY, not a status line. Piped to a file or a service manager, every
// control sequence here would be garbage in the log and the spinner a
// hundred-byte-a-second leak, so a non-TTY stream makes the whole thing a
// no-op — logs untouched, nothing written. The `isTTY` check is the feature.
//
// ⚠ The spinner interval is `unref()`'d. It must never be the thing keeping
// the process alive: shutdown already has six things to stop, and a timer
// that pins the event loop would make `beth` hang on Ctrl-C with no symptom
// but the hang.

export type StatusOut = { isTTY?: boolean; write(s: string): unknown };
type Timers = {
  setInterval(fn: () => void, ms: number): { unref?(): unknown };
  clearInterval(h: unknown): void;
};
type ConsoleLike = Pick<Console, 'log' | 'warn' | 'error'>;

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const CLEAR = '\r\x1b[2K';

export class StatusLine {
  private readonly label: string;
  private readonly out: StatusOut;
  private readonly timers: Timers;
  private readonly intervalMs: number;
  private readonly enabled: boolean;
  private frame = 0;
  private handle: unknown = null;
  private shown = false;
  private restore: (() => void) | null = null;

  constructor(opts: { label: string; out?: StatusOut; timers?: Timers; intervalMs?: number }) {
    this.label = opts.label;
    this.out = opts.out ?? process.stdout;
    this.timers = opts.timers ?? { setInterval, clearInterval };
    this.intervalMs = opts.intervalMs ?? 80;
    this.enabled = Boolean(this.out.isTTY);
  }

  /** True while the spinner is running. */
  get busy(): boolean {
    return this.handle !== null;
  }

  /** Draw the line (idle form). No-op off a TTY. */
  show(): void {
    if (!this.enabled) return;
    this.shown = true;
    this.render();
  }

  /** Start or stop the spinner. Idempotent either way. */
  setBusy(on: boolean): void {
    if (!this.enabled) return;
    if (on && this.handle === null) {
      const h = this.timers.setInterval(() => this.tick(), this.intervalMs);
      h.unref?.();
      this.handle = h;
      this.shown = true;
      this.render();
    } else if (!on && this.handle !== null) {
      this.timers.clearInterval(this.handle);
      this.handle = null;
      this.frame = 0;
      if (this.shown) this.render();
    }
  }

  /** Advance one spinner frame. Public so a test can drive it without a clock. */
  tick(): void {
    if (!this.enabled || this.handle === null) return;
    this.frame = (this.frame + 1) % FRAMES.length;
    this.render();
  }

  /**
   * Wrap a console's writers so their output lands ABOVE the line. Returns the
   * undo. Off a TTY the console is left exactly as it was.
   */
  install(c: ConsoleLike = console): () => void {
    if (!this.enabled) return () => {};
    const orig = { log: c.log, warn: c.warn, error: c.error };
    for (const k of ['log', 'warn', 'error'] as const) {
      c[k] = (...args: unknown[]) => {
        if (this.shown) this.out.write(CLEAR);
        orig[k].apply(c, args);
        if (this.shown) this.render();
      };
    }
    this.restore = () => {
      c.log = orig.log;
      c.warn = orig.warn;
      c.error = orig.error;
      this.restore = null;
    };
    return this.restore;
  }

  /** Stop the spinner, clear the line, put the console back. */
  stop(): void {
    if (!this.enabled) return;
    if (this.handle !== null) {
      this.timers.clearInterval(this.handle);
      this.handle = null;
    }
    if (this.shown) this.out.write(CLEAR);
    this.shown = false;
    this.restore?.();
  }

  private render(): void {
    // Idle keeps the spinner's two columns as blanks: the label must not slide
    // left when a turn ends and back when the next begins.
    const spin = this.handle !== null ? `${FRAMES[this.frame]} ` : '  ';
    this.out.write(`${CLEAR}${spin}beth: ${this.label}`);
  }
}
