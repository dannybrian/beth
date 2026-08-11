// .claude/skills/plans/lib/trailer.mjs
//
// Should this commit carry a `Plan:` trailer, and for which plan?
//
// The trailer is the ONLY input to the derived commit↔plan linkage, and a
// trailer in git history is immutable — a wrong one can never be corrected in
// place, only excluded downstream (see ./commits.mjs). So the stamp itself has
// to be conservative: when we are not confident the claim in front of us is
// this terminal's current work, we stamp nothing. An unstamped commit is a
// small, recoverable gap; a misattributed one poisons a plan's history.
//
// Pure and injected (record + env + clock come from the caller) so the guards
// are testable without a git repo, a terminal, or a session on disk.

import { isAmbiguousSessionId } from './session.mjs';

/** The env var a terminal sets to skip the trailer on one unrelated commit. */
export const OPT_OUT_ENV = 'PLANS_NO_TRAILER';

/**
 * Commit sources where a trailer would either churn or mis-attribute:
 *   merge  — the merge commit belongs to no single plan
 *   squash — same, for the combined message
 *   commit — an amend/`-c`, whose message is already written (and may already
 *            carry a trailer from the original stamp)
 */
function isSkippedSource(source) {
  return source === 'merge' || source === 'squash' || source === 'commit';
}

/** Affirmative env values. `PLANS_NO_TRAILER=0` must NOT read as an opt-out. */
function isAffirmative(v) {
  if (v === undefined || v === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}

/**
 * @param {object}  opts
 * @param {string}  [opts.source]      git's prepare-commit-msg source arg
 * @param {object}  [opts.record]      this session's claim record, or null
 * @param {string}  [opts.sessionId]   defaults to record.session_id
 * @param {object}  [opts.env]         environment to read the opt-out from
 * @param {number}  [opts.now]
 * @param {number}  [opts.staleHours]  same 4h threshold the board calls [stale]
 * @returns {{stamp: boolean, reason: string, planPath: string|null}}
 */
export function trailerDecision({
  source = '',
  record = null,
  sessionId = null,
  env = {},
  now = Date.now(),
  staleHours = 4,
} = {}) {
  const no = (reason) => ({ stamp: false, reason, planPath: null });

  if (isSkippedSource(source)) return no('source-skipped');

  // Checked before the claim so a terminal can opt out even when its claim is
  // perfectly healthy — that IS the case it exists for (a director's own
  // recording commits, made from a tab that legitimately holds a plan).
  if (isAffirmative(env[OPT_OUT_ENV])) return no('opted-out');

  if (!record || !record.plan_path) return no('no-claim');

  // A `fallback-<hash>` id is sha1(tty + ':' + cwd): every session in one
  // directory without session env resolves to the SAME id, so the record we
  // just read may be another terminal's. Stamping from it is a coin flip.
  const sid = sessionId ?? record.session_id ?? null;
  if (isAmbiguousSessionId(sid)) return no('ambiguous-session');

  // A claim nobody has heartbeated in 4h is not active work — it is a record
  // left behind by a session that moved on or died. Trailers stamped from
  // days-stale claims are exactly how dozens of commits got another plan's name.
  const ageHours = record.last_heartbeat
    ? (now - new Date(record.last_heartbeat).getTime()) / 3_600_000
    : Infinity;
  if (!(ageHours <= staleHours)) return no('stale-claim'); // NaN-safe

  return { stamp: true, reason: 'claimed', planPath: record.plan_path };
}
