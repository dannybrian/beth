// Director-role handoff policy.
//
// Only one director exists at a time. The `/director` resume ritual's
// `claim --force` assumes the displaced session record is a DEAD predecessor —
// false when a terminal director is live. So the harness never forces:
//
//   - a live peer holds the director plan  → start SHADOW (claimless, no ritual)
//   - nobody holds it                      → the role is FREE to take
//
// Promotion is always a deliberate act by Danny, re-checked at the moment it
// happens. The harness itself never writes plan state — it permits or refuses,
// and the director session does the claiming through /plans as usual.
import fs from 'node:fs';
import path from 'node:path';

const STALE_MS = 4 * 60 * 60 * 1000; // matches the /plans skill's staleness rule

export type SessionRecord = {
  session_id: string;
  plan_path?: string;
  claude_session_id?: string;
  cwd?: string;
  last_heartbeat?: string;
};

export type RoleAssessment = {
  mode: 'shadow' | 'director';
  reason: string;
  blockedBy?: SessionRecord;
};

/**
 * Session records whose heartbeat is fresh enough to mean a REAL working session.
 * Shared with the work index: a plan's `owner` frontmatter is only a live claim if
 * one of these names it, and the one-click handoff has to refuse on exactly that.
 */
export function liveRecords(repo: string): SessionRecord[] {
  const dir = path.join(repo, '.claude', 'sessions');
  if (!fs.existsSync(dir)) return [];
  const now = Date.now();
  const out: SessionRecord[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SessionRecord;
      const beat = rec.last_heartbeat ? Date.parse(rec.last_heartbeat) : 0;
      if (beat && now - beat < STALE_MS) out.push(rec);
    } catch {
      /* unreadable record — treat as absent */
    }
  }
  return out;
}

export function assessRole(repo: string, directorPlan: string): RoleAssessment {
  const holder = liveRecords(repo).find((r) => r.plan_path === directorPlan);
  if (holder) {
    return {
      mode: 'shadow',
      reason: `A live terminal session (${holder.session_id.slice(0, 20)}…) holds ${directorPlan}. Running claimless.`,
      blockedBy: holder,
    };
  }
  return { mode: 'director', reason: `No live session holds ${directorPlan}. The director role is free to take.` };
}

/** Re-check at the moment of promotion — a peer may have claimed since startup. */
export function canPromote(repo: string, directorPlan: string): { ok: boolean; reason: string } {
  const a = assessRole(repo, directorPlan);
  return a.mode === 'director'
    ? { ok: true, reason: a.reason }
    : { ok: false, reason: `Refusing to promote: ${a.reason} Have the terminal director wrap and release first.` };
}

/** The role constraint, phrased for the director session's system prompt. */
export function roleInstruction(a: RoleAssessment, directorPlan: string): string {
  if (a.mode === 'shadow') {
    return [
      `ROLE — claimless shadow director. ${a.reason}`,
      `You act the director role conversationally but MUST NOT run the /director resume ritual and MUST NOT claim any plan.`,
      `Never run \`/plans claim\` and never \`claim --force\` — especially not on ${directorPlan}. The live peer is not a dead predecessor.`,
      `You may read everything: plans, INDEX, git history, queues.`,
    ].join(' ');
  }
  return [
    `ROLE — director. ${a.reason}`,
    `You may take the role, but claiming is still a deliberate act: claim ${directorPlan} only when Danny asks for it, and never with --force.`,
  ].join(' ');
}
