// Where this repo lives on the web, derived from the repo itself.
//
// This is not the harness learning about a project: a git remote is something
// every repo already declares, the same way `repoSnapshot` reads the branch.
// Nothing here is configured and nothing is guessed — no remote, no link.
//
// History: a per-plan "open on GitHub" button lived here until 2026-09-01 and
// was deleted with its lesson recorded in CLAUDE.md — a BLOB url needs the ref
// resolved at the click and a file-url SHAPE the remote does not reveal
// (GitLab wants `/-/blob/`). This is the narrower thing that survives both
// objections: the repo's HOME page has no ref in it, and `https://host/owner/
// repo` is the one shape every forge agrees on (GitHub, GitLab, Gitea,
// Codeberg, Bitbucket). So any https-shaped host is accepted, and the page
// labels the link by host rather than assuming the word "GitHub".
import { execFileSync } from 'node:child_process';

/**
 * `git@github.com:owner/repo.git`, `https://github.com/owner/repo` and the
 * other spellings of the same thing, reduced to a browsable home page.
 *
 * The SSH form is not a URL — `URL` parses `git@github.com:owner/repo` as a
 * `git:` scheme with the whole rest as its path — so it is matched, not parsed.
 * Returns null for anything that is not `owner/repo` on a host: a deeper path
 * is a subgroup or a mirror layout, and a plausible 404 is worse than no link.
 */
export function webHome(remote: string): string | null {
  const url = remote.trim();
  if (!url) return null;
  const m =
    // scp-style: [user@]host:owner/repo
    /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(url) ??
    // ssh://, git://, https://, http:// — with an optional user@ and port
    /^(?:ssh|git|https?):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+)$/.exec(url);
  if (!m) return null;
  const host = m[1].toLowerCase();
  // A local path or a bare hostname with no dot is a mirror on this machine or
  // an ssh alias, and neither has a page to open.
  if (!host.includes('.')) return null;
  const path = m[2].replace(/\.git\/?$/, '').replace(/^\/+|\/+$/g, '');
  if (!/^[^/\s]+\/[^/\s]+$/.test(path)) return null;
  return `https://${host}/${path}`;
}

/**
 * The repo's home on the web, or null. Read ONCE at boot: a remote changes
 * about as often as a repo is created, and the `hello` that carries it is sent
 * inside the stream handler, where a wedged `git` would hold the connection.
 */
export function repoHome(repo: string): string | null {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repo,
      timeout: 2000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return webHome(remote);
  } catch {
    return null;
  }
}
