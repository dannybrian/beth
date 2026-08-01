// What to CALL the director, in the harness's own voice.
//
// The harness supplies the role and the bound repo supplies the person, so the
// name cannot be a constant here. It matters in exactly one place and it matters
// a lot: a permission card that says "Claude wants to use Bash" is talking about
// a stranger. Danny is in a conversation with a named director, and the prompt
// interrupting that conversation should be hers.
//
// Read from .claude/DIRECTOR.md, which is where a project already writes "You are
// **Beth**." No project-specific knowledge lands here — only the shape of a
// sentence any director's instructions would contain — and a repo that phrases it
// differently sets HARNESS_DIRECTOR_NAME instead.
import fs from 'node:fs';
import path from 'node:path';

/** Unnamed is a legitimate outcome: a repo with no DIRECTOR.md gets a competent stranger. */
export const UNNAMED = 'The director';

// Both anchored on a capital, which is what tells "You are **Beth**" from
// "You are the standing director on this project".
const PATTERNS = [/\bYou are\s+\*{0,2}([A-Z][A-Za-z'’-]{1,20})\*{0,2}/, /\bYour name is\s+\*{0,2}([A-Z][A-Za-z'’-]{1,20})\*{0,2}/];

/** The director's name for this repo. Never throws — an unreadable guide is just unnamed. */
export function directorName(repo: string, override = ''): string {
  if (override.trim()) return override.trim();
  let guide = '';
  try {
    guide = fs.readFileSync(path.join(repo, '.claude', 'DIRECTOR.md'), 'utf8');
  } catch {
    return UNNAMED;
  }
  for (const re of PATTERNS) {
    const m = re.exec(guide);
    if (m) return m[1];
  }
  return UNNAMED;
}
