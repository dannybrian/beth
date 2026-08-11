// .claude/skills/plans/lib/session.mjs
//
// Session identity for the /plans tracker.
//
// A "session" is one Claude Code conversation (or one terminal tab). Its id keys
// .claude/sessions/<id>.json, which records which plan that session has claimed.
// Identity MUST be unique per conversation: two sessions sharing an id silently
// steal each other's claims and heartbeat each other's plans.
//
// Everything here is pure and takes its environment by injection, so tests can
// state an environment rather than mutate process.env.

import crypto from 'node:crypto';
import path from 'node:path';
import { execSync } from 'node:child_process';

/** Read the controlling tty, or '' when there is none (the desktop app has none). */
export function defaultReadTty() {
  try {
    return execSync('tty', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

/**
 * Resolve this session's stable id, most specific source first.
 *
 * @param {object}   [opts]
 * @param {object}   [opts.env]     environment to read
 * @param {string}   [opts.cwd]     working directory
 * @param {function} [opts.readTty] returns the tty path, or ''
 * @returns {string}
 */
export function sessionId({
  env = process.env,
  cwd = process.cwd(),
  readTty = defaultReadTty,
} = {}) {
  if (env.TERM_SESSION_ID) return 'term-' + env.TERM_SESSION_ID;
  if (env.ITERM_SESSION_ID) return 'iterm-' + env.ITERM_SESSION_ID;
  if (env.CLAUDE_SESSION_ID) return 'claude-' + env.CLAUDE_SESSION_ID;
  // The Claude Code desktop app sets CLAUDE_CODE_SESSION_ID and nothing else, and
  // has no tty — so without this branch every desktop conversation in one directory
  // hashed to the same id and silently shared one claim.
  if (env.CLAUDE_CODE_SESSION_ID) return 'claude-' + env.CLAUDE_CODE_SESSION_ID;
  const h = crypto.createHash('sha1').update(readTty() + ':' + cwd).digest('hex').slice(0, 8);
  return 'fallback-' + h;
}

/** True when the id came from the non-unique cwd-hash fallback. */
export function isAmbiguousSessionId(sid) {
  return typeof sid === 'string' && sid.startsWith('fallback-');
}

/**
 * May a lifecycle op (claim / status / release) run under this session id?
 *
 * A `fallback-<hash>` id is shared by every session in one directory, so the
 * record it reads and writes may belong to a different terminal: on 2026-07-30
 * a `release` issued under a colliding fallback dropped ANOTHER session's claim
 * (game/plans/unity plan 164). Warning was not enough — these ops write, so
 * they refuse and make the operator say `--force`.
 *
 * `--force` still allows it, because a genuinely lone session (no terminal env,
 * no tty) must not be locked out of the tracker entirely; it just has to accept
 * the risk explicitly, and is warned again when it does.
 *
 * @returns {{allow: boolean, reason: string, message: string|null}}
 */
export function lifecycleGuard({ sid, force = false } = {}) {
  if (!isAmbiguousSessionId(sid)) {
    return { allow: true, reason: 'stable-id', message: null };
  }
  const why =
    `this session has no stable id (no TERM_SESSION_ID, no ITERM_SESSION_ID, no ` +
    `CLAUDE_CODE_SESSION_ID, no tty), so it resolved to the collision-prone ` +
    `${sid}. Fallback ids are shared by every session in this directory and have ` +
    `released the wrong session's claim before.`;
  if (force) {
    return { allow: true, reason: 'forced-ambiguous', message: `WARNING: ${why} Proceeding because --force was passed.` };
  }
  return { allow: false, reason: 'ambiguous-session', message: `REFUSING: ${why} Re-run with --force if this is the only session here.` };
}

/**
 * Canonicalize a repo-relative plan path so cosmetically different spellings of
 * the same file collapse to one key ('plans/x.md', './plans/x.md',
 * 'plans//x.md' all normalize identically).
 *
 * `claimDecision` compares `ownerPlanPath` against `planPath` for IDENTITY, not
 * just for display — a session record's `plan_path` and a freshly-resolved
 * claim target must agree on what "the same plan" looks like as a string, or a
 * live owner reachable only through a differently-spelled path looks
 * "moved on" and gets displaced with no `--force`. index.mjs's `resolveRel`
 * must run every plan path through this before it reaches `claimDecision`.
 */
export function normalizePlanPath(p) {
  return path.normalize(p);
}

/**
 * Decide whether `claimant` may take a plan currently held by `currentOwner`.
 *
 * Pure: the caller supplies the owner's last heartbeat (read from that session's
 * record) and the current time, so this needs no filesystem and no clock.
 *
 * A stale owner is treated as gone — that is the existing `prune` semantics, and
 * it keeps a crashed session from blocking a plan forever.
 *
 * @returns {{allow: boolean, reason: string, currentOwner?: string}}
 */
export function claimDecision({
  currentOwner,
  claimant,
  ownerLastHeartbeat = null,
  ownerPlanPath = null,
  planPath = null,
  now = Date.now(),
  staleHours = 4,
  force = false,
}) {
  if (!currentOwner) return { allow: true, reason: 'unowned' };
  if (currentOwner === claimant) return { allow: true, reason: 'self' };

  // The owner's record names a DIFFERENT plan, so this owner field is a leftover:
  // claiming a new plan overwrites the session record but never clears the old
  // plan's owner. Refusing here would lock a plan nobody actually holds.
  //
  // Both sides are normalized HERE rather than trusting the writer: ownerPlanPath
  // comes off a session record on disk that may predate normalizePlanPath, and a
  // cosmetic spelling difference must never read as "the owner moved on".
  const ownerPath = ownerPlanPath ? normalizePlanPath(ownerPlanPath) : null;
  const thisPath  = planPath ? normalizePlanPath(planPath) : null;
  if (ownerPath && thisPath && ownerPath !== thisPath) {
    return { allow: true, reason: 'owner-moved-on', currentOwner };
  }

  const ageHours = ownerLastHeartbeat
    ? (now - new Date(ownerLastHeartbeat).getTime()) / 3_600_000
    : Infinity;
  if (ageHours > staleHours) return { allow: true, reason: 'owner-stale' };

  if (force) return { allow: true, reason: 'forced', currentOwner };
  return { allow: false, reason: 'owned-by-live-session', currentOwner };
}

/**
 * May this session write to a plan whose frontmatter says `currentOwner`?
 *
 * Commands that mutate the claimed plan (status, tick) must ask first: `--force`
 * makes displacement a supported operation and the displaced session is never
 * notified — it would otherwise keep heartbeating, and could flip the status of a
 * plan someone else now owns.
 */
export function ownsPlan(currentOwner, claimant) {
  return Boolean(currentOwner) && currentOwner === claimant;
}

/**
 * Decide whether releasing should clear the plan's `owner` field.
 *
 * Releasing always drops OUR session record; this decides only whether the plan
 * file's owner is cleared too. A session that was superseded must not null out
 * the ownership of whoever took over.
 *
 * @returns {{clearOwner: boolean, reason: string}}
 */
export function releaseDecision({ currentOwner, claimant }) {
  if (!currentOwner) return { clearOwner: false, reason: 'already-unowned' };
  if (currentOwner === claimant) return { clearOwner: true, reason: 'owner' };
  return { clearOwner: false, reason: 'not-owner' };
}
