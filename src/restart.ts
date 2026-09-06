// /restart — the harness exits and the `beth` wrapper starts it again.
//
// The harness never replaces itself: it is a child of bin/beth.mjs, which is
// what the terminal is running, so a successor spawned from here would be
// nobody's child — no Ctrl-C, no status line, an instance record pointing at a
// dead pid. Instead it exits with RESTART_EXIT and the wrapper relaunches on
// exactly that code; any other exit is a stop, as before. That is also why a
// broken boot does not loop: the new process fails with some other code, the
// wrapper exits, and the terminal says so.
//
// The session RESUMES (the same way a normal start does), so she comes back
// knowing where the conversation was; the page's transcript does not, because
// the replay is in-process history. Workers do not survive either — background
// tasks live inside the CLI subprocess — which is what the refusal below guards.

/** EX_TEMPFAIL. Mirrored in bin/beth.mjs, which cannot import this file's neighbours cheaply. */
export const RESTART_EXIT = 75;

/**
 * Whether a restart may happen NOW. Two things make it unsafe, and both are
 * invisible from a page: a turn in flight is cut mid-sentence, and a running
 * worker is killed with its work — a restart that looked clean while a
 * two-hour build subagent quietly died is the failure this exists to refuse.
 */
export function restartVerdict(state: { busy: boolean; workers: number }): { ok: true } | { ok: false; reason: string } {
  if (state.busy) return { ok: false, reason: 'a turn is in flight — /stop first, or wait for it to end' };
  if (state.workers > 0) {
    return {
      ok: false,
      reason: `${state.workers} worker${state.workers === 1 ? ' is' : 's are'} running and would die with the harness — let them finish, or close them from the panel`,
    };
  }
  return { ok: true };
}
