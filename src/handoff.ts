// Handing a plan off to where the work actually happens.
//
// Two targets: VSCode (a URL scheme the browser opens itself) and Claude Code —
// the one that matters. The harness runs locally with shell access, so it can
// open a terminal already sitting in the repo with a seeded prompt about that
// plan. Read a plan in the panel, decide it needs real work, hand it to a fresh
// implementer in one click.
//
// ⚠️ THIS SPAWNS A SHELL. It is only safe because the API it hangs off binds to
// loopback (see main.ts). If the UI is ever exposed — a tunnel, HARNESS_BIND —
// this becomes remote code execution. Do not move it to the public listener.
//
// ⚠️ AND IT REFUSES, RATHER THAN WARNS. beadgame runs one implementer at a time
// and `/plans` claims enforce it. A one-click handoff that quietly started a
// second session on a claimed plan would undo that discipline, and a warning is
// not enough: warnings get clicked through. A live claim is a hard no.
import { spawn } from 'node:child_process';
import type { WorkIndex } from './workIndex.ts';
import { taskSummary } from './workItems.ts';

export type HandoffVerdict = { ok: boolean; reason: string; command?: string };

/**
 * The prompt a fresh Claude Code session opens with.
 *
 * It deliberately does NOT tell it the plan is claimed for it, because the
 * harness never writes plan state — `/plans` owns that, and it is the only
 * writer. So the seeded session claims the plan itself, exactly as a human
 * starting work would, and refuses in exactly the same places.
 */
export function seedPrompt(index: WorkIndex, path: string): string {
  const item = index.byPath(path);
  if (!item) return `Read ${path} and tell me where it stands before changing anything.`;
  const t = taskSummary(item);
  return [
    `You are picking up "${item.title}" (${path}).`,
    `Status is ${item.status}${item.priority ? `, ${item.priority}` : ''};`,
    t ? `${t.done} of ${t.total} tasks are ticked.` : 'the plan has no task checkboxes.',
    `Start by running /plans claim ${path} — never with --force. If the claim is refused, stop and say so rather than working unclaimed.`,
    `Then read the plan and tell me your intended first step before you change anything.`,
  ].join(' ');
}

/**
 * Re-check the claim AT THE MOMENT OF THE CLICK, the way canPromote does — the
 * panel Danny is looking at may be seconds old, and a peer may have claimed since.
 */
export function canHandOff(index: WorkIndex, path: string): HandoffVerdict {
  const item = index.byPath(path);
  if (!item) return { ok: false, reason: `${path} is not in the work index.` };
  if (item.claim?.live) {
    return {
      ok: false,
      reason:
        `"${item.spoken}" is claimed by a live session (${item.claim.owner}` +
        `${item.claim.lastHeartbeat ? `, last heartbeat ${item.claim.lastHeartbeat}` : ''}). ` +
        `One implementer at a time — have that session wrap and release before starting another.`,
    };
  }
  if (item.claim) {
    return {
      ok: true,
      reason: `"${item.spoken}" has a stale owner (${item.claim.owner}) — no live session holds it, so it is free to take.`,
    };
  }
  return { ok: true, reason: `"${item.spoken}" is unclaimed.` };
}

/** Shell-quote for the `do script` string we hand to Terminal via osascript. */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const osaq = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Open a Terminal window in the repo running `claude` with the seeded prompt.
 *
 * Interactive on purpose — NOT `claude --bg`. The whole point is to take
 * something over and think in it; a background agent would be a second
 * implementer with nobody watching, which is the thing the claim rules exist to
 * prevent.
 */
export function buildCommand(opts: { repo: string; claudeBin: string; prompt: string }): string {
  // Everything is single-quoted. The prompt is model-authored prose containing
  // quotes, backticks and slashes, and it is going through TWO layers of
  // interpretation (osascript's string, then the shell) — unquoted, a stray
  // backtick would execute.
  return `cd ${shq(opts.repo)} && ${shq(opts.claudeBin)} ${shq(opts.prompt)}`;
}

export function handOffToClaude(opts: {
  repo: string;
  claudeBin: string;
  prompt: string;
}): { command: string } {
  const inner = buildCommand(opts);
  if (process.platform === 'darwin') {
    spawn('osascript', ['-e', `tell application "Terminal" to do script "${osaq(inner)}"`, '-e', 'tell application "Terminal" to activate'], {
      stdio: 'ignore',
      detached: true,
    }).unref();
  } else {
    // No assumption about a terminal emulator elsewhere — run it detached and
    // let the caller see the command rather than guessing at x-terminal-emulator.
    spawn('sh', ['-c', inner], { stdio: 'ignore', detached: true }).unref();
  }
  return { command: inner };
}
