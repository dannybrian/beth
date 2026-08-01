// One line per tool call, for the transcript.
//
// The raw input was rendered as JSON, which put the useful part — which file,
// which command — behind three lines of punctuation and an absolute path long
// enough to wrap. These are glances, not records: they sit between her sentences
// while she works, and the question they answer is "what is she doing right now".
//
// So: a verb and a subject. The full input is still carried alongside and hangs
// off the element's title, because the summary is deliberately lossy and the
// moment you actually need the arguments you need all of them.
import os from 'node:os';

/**
 * Longest summary worth showing. Sized against the transcript's 70ch column: a
 * line that wraps is the thing this was built to stop.
 */
const MAX = 78;

const clip = (s: string, n = 72) => {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/**
 * Paths as Danny thinks of them. The bound repo is the frame of reference, so
 * `/Users/dbrian/Sources/beadgame/plans/x.md` is `plans/x.md`; anything outside
 * it keeps enough to be recognisable, with the home directory as `~`.
 */
function rel(p: unknown, repo: string): string {
  if (typeof p !== 'string' || !p) return '';
  if (repo && (p === repo || p.startsWith(`${repo}/`))) return p.slice(repo.length + 1) || '.';
  const home = os.homedir();
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/**
 * The repo path spelled out INSIDE a command — `git -C /Users/…/beadgame status`,
 * `grep -r x /Users/…/beadgame`. rel() only reaches path-shaped arguments, and a
 * bare `cd` into an absolute path is exactly what made these wrap to three lines.
 */
function deRepo(text: string, repo: string): string {
  let out = text;
  if (repo) out = out.split(repo).join('.');
  const home = os.homedir();
  return out.split(home).join('~');
}

/** `mcp__harness__plans` → `plans`. The server prefix is never the interesting part. */
const shortName = (name: string) => name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '').replace(/^mcp__/, '');

/** Scalar arguments as `k=v`, for a tool with no shape of its own. */
function scalars(input: Record<string, unknown>): string {
  return Object.entries(input)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .slice(0, 3)
    .map(([k, v]) => `${k}=${clip(String(v), 28)}`)
    .join(' ');
}

/**
 * A glanceable line for one tool call. Never throws: a summary that blows up on
 * an unexpected input shape would take the transcript with it.
 */
export function summarizeTool(name: string, input: Record<string, unknown>, repo = ''): string {
  const i = input ?? {};
  const at = (k: string) => rel(i[k], repo);
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');

  try {
    switch (shortName(name)) {
      case 'Read': {
        const span = typeof i.offset === 'number' ? `:${i.offset}${typeof i.limit === 'number' ? `+${i.limit}` : ''}` : '';
        return clip(`read ${at('file_path')}${span}`, MAX);
      }
      case 'Write':
        return clip(`write ${at('file_path')}`, MAX);
      case 'Edit':
        return clip(`edit ${at('file_path')}${i.replace_all ? ' (all)' : ''}`, MAX);
      case 'NotebookEdit':
        return clip(`edit ${at('notebook_path')}`, MAX);
      // The command, not the description: the description is her paraphrase and
      // the command is what actually ran.
      case 'Bash':
        return clip(`run ${deRepo(str('command') || str('description'), repo)}${i.run_in_background ? ' &' : ''}`, MAX);
      case 'BashOutput':
        return 'check background output';
      case 'KillShell':
        return 'stop background command';
      case 'Glob':
        return clip(`glob ${str('pattern')}${i.path ? ` in ${at('path')}` : ''}`, MAX);
      case 'Grep':
        return clip(`grep ${str('pattern')}${i.path ? ` in ${at('path')}` : ''}`, MAX);
      case 'Task':
      case 'Agent':
        return clip(`dispatch ${str('description') || str('subagent_type') || 'worker'}`, MAX);
      case 'Skill':
        return clip(`/${str('skill')} ${str('args')}`, MAX);
      case 'WebFetch':
        try {
          return clip(`fetch ${new URL(str('url')).host}`, MAX);
        } catch {
          return clip(`fetch ${str('url')}`, MAX);
        }
      case 'WebSearch':
        return clip(`search ${str('query')}`, MAX);
      case 'TodoWrite':
        return `todos (${Array.isArray(i.todos) ? i.todos.length : 0})`;
      case 'AskUserQuestion':
        return 'ask';
      default: {
        const args = scalars(i as Record<string, unknown>);
        return clip(`${shortName(name)}${args ? ` ${args}` : ''}`, MAX);
      }
    }
  } catch {
    return shortName(name);
  }
}
