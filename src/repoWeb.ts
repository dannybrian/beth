// Where this repo lives on the web, derived from the repo itself.
//
// This is not the harness learning about a project: a git remote is something
// every repo already declares, in the same way `repoSnapshot` reads the branch.
// Nothing here is configured and nothing is guessed — no remote, no icon.
//
// ⚠️ github.com ONLY, on purpose. The remote tells us the host and the path but
// not the SHAPE of that host's file URLs (GitLab wants `/-/blob/`, Gitea and
// Bitbucket want something else again, and a self-hosted host is unknowable from
// the URL alone). A button that opens the wrong page is worse than no button, so
// anything else returns null and the row renders exactly as it does today.
import { execFileSync } from 'node:child_process';

/** Same contract as greeting.ts's helper: slow or absent git costs milliseconds. */
const git = (repo: string, args: string[]): string | null => {
  try {
    return execFileSync('git', args, {
      cwd: repo,
      timeout: 2000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};

/**
 * `git@github.com:owner/repo.git` and `https://github.com/owner/repo` and the
 * four other spellings of the same thing, reduced to a browsable base.
 *
 * The SSH form is not a URL — `URL` parses `git@github.com:owner/repo` as a
 * `git:` scheme with the whole rest as its path — so it is matched, not parsed.
 */
export function webBase(remote: string): string | null {
  const url = remote.trim();
  if (!url) return null;
  const m =
    // scp-style: [user@]host:owner/repo
    /^(?:[\w.-]+@)?github\.com:(.+)$/.exec(url) ??
    // ssh://, git://, https://, http://
    /^(?:ssh|git|https?):\/\/(?:[^@/]+@)?github\.com\/(.+)$/.exec(url);
  if (!m) return null;
  const path = m[1].replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
  // owner/repo and nothing else — a remote with a deeper path is not a repo root
  // and building a blob URL from it would produce a plausible 404.
  if (!/^[^/]+\/[^/]+$/.test(path)) return null;
  return `https://github.com/${path}`;
}

/**
 * The ref to link at. The BRANCH rather than a fixed `main`, because a plan
 * written on a feature branch does not exist on main — and a detached HEAD has
 * no branch to name, so the commit itself is both the honest answer and a
 * permanent one.
 */
export function webRef(repo: string): string {
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch && branch !== 'HEAD') return branch;
  return git(repo, ['rev-parse', 'HEAD']) ?? 'HEAD';
}

/** Whether this repo has a github.com origin at all — read once, at boot. */
export function hasWeb(repo: string): boolean {
  const remote = git(repo, ['remote', 'get-url', 'origin']);
  return Boolean(remote && webBase(remote));
}

/**
 * The blob URL for one repo-relative path, resolved AT CLICK TIME.
 *
 * The ref is read now rather than served with the page: Danny switches branches
 * mid-session, and a URL baked into a page opened this morning would quietly
 * point at wherever he was standing then.
 */
export function blobUrl(repo: string, relPath: string): string | null {
  const remote = git(repo, ['remote', 'get-url', 'origin']);
  const base = remote ? webBase(remote) : null;
  if (!base) return null;
  const ref = webRef(repo);
  const encoded = relPath.split('/').map(encodeURIComponent).join('/');
  return `${base}/blob/${encodeURIComponent(ref)}/${encoded}`;
}
