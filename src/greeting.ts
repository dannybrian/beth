// The boot greeting, and why it kept being the same greeting.
//
// It was always LLM-written — but a model given identical inputs and an
// instruction that dictates the content ("name the repo and branch") writes the
// same sentence every time, and it has no way to know it has said it before: the
// conversation that produced yesterday's greeting is gone. So the sameness was
// not a missing model, it was a missing MEMORY and a missing SUBJECT.
//
// Both are fixable from here, cheaply:
//
//   - keep the last few openings and hand them back with "not these" — the only
//     thing that can break a mode collapse is knowing where the mode is;
//   - hand her what is actually TRUE at this boot — the branch, the dirt, the
//     last commit, what is in flight, the clock, how long since she was last up
//     — so there is something to be specific ABOUT. "Back already?" after a
//     ninety-second restart is a different greeting because it is a different
//     morning, not because the wording was shuffled.
//
// The facts are also a saving: she used to spend a git tool call at boot to
// learn the branch and whether the tree was clean, before the first word.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { HarnessConfig } from './config.ts';
import type { WorkItem } from './workItems.ts';

export type Opening = { at: string; text: string };

/**
 * How many openings to remember. Enough to show a habit forming — three is a
 * coincidence, six is a rut — and short enough that the prompt stays small.
 */
const KEEP = 6;

/** An opening long enough to be a report is not an opening. Stored truncated. */
const MAX_STORED = 400;

export class Greetings {
  private file: string;

  /**
   * Per-repo, beside the other state: greetings name the project, so the rut to
   * avoid is this project's rut. That argument survives personas intact — what
   * it does not cover is two directors sharing one repo, where a single file
   * would have each of them avoiding the other's phrasings. So the rut is keyed
   * by BOTH: this project, this person.
   *
   * ⚠️ Unlike her memory, which follows her between repos, this stays here. A
   * habit is formed against a project; what she knows about Danny is not.
   */
  constructor(cfg: HarnessConfig, persona = '') {
    this.file = path.join(cfg.stateDir, persona ? `greetings-${persona}.json` : 'greetings.json');
  }

  /** Newest first. */
  recent(): Opening[] {
    try {
      const all = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Opening[];
      return Array.isArray(all) ? all.slice(0, KEEP) : [];
    } catch {
      return [];
    }
  }

  record(text: string) {
    const clean = text.trim().replace(/\s+/g, ' ').slice(0, MAX_STORED);
    if (!clean) return;
    const next = [{ at: new Date().toISOString(), text: clean }, ...this.recent()].slice(0, KEEP);
    try {
      fs.writeFileSync(this.file, JSON.stringify(next, null, 2));
    } catch {
      /* a state dir we cannot write is not worth failing a greeting over */
    }
  }

  /** When she last opened here — the gap that tells an arrival from a restart. */
  lastAt(): number | null {
    const at = this.recent()[0]?.at;
    const t = at ? Date.parse(at) : NaN;
    return Number.isFinite(t) ? t : null;
  }
}

export type RepoSnapshot = {
  branch: string | null;
  /** Files with uncommitted changes. 0 is a clean tree; null is not a git repo. */
  dirty: number | null;
  lastCommit: { subject: string; age: string } | null;
};

const git = (repo: string, args: string[]): string | null => {
  try {
    // Short timeout and stderr swallowed: this is greeting material, and a slow
    // or absent git must delay the first word by milliseconds, not seconds.
    return execFileSync('git', args, { cwd: repo, timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

/** What git can say about the tree in two spawns. All of it optional. */
export function repoSnapshot(repo: string): RepoSnapshot {
  const status = git(repo, ['status', '--porcelain', '-b']);
  const lines = status === null ? null : status.split('\n').filter(Boolean);
  // The `-b` header is "## main...origin/main [ahead 2]" — or "## HEAD (no branch)".
  const head = lines?.[0]?.startsWith('##') ? lines[0].slice(2).trim() : null;
  const branch = head ? (head.split(/\.\.\.|\s/)[0] || null) : null;
  const log = git(repo, ['log', '-1', '--format=%s%n%cr']);
  const [subject, age] = (log ?? '').split('\n');
  return {
    branch,
    dirty: lines === null ? null : lines.filter((l) => !l.startsWith('##')).length,
    lastCommit: subject && age ? { subject, age } : null,
  };
}

/** Rounded, and phrased as the difference it makes rather than as a duration. */
function sinceLine(now: number, lastAt: number | null): string {
  if (lastAt === null) return 'This is the first time you have booted in this repo.';
  const mins = Math.max(0, Math.round((now - lastAt) / 60_000));
  if (mins < 15) return `You were up ${mins < 2 ? 'a moment' : `${mins} minutes`} ago — this is a RESTART, not an arrival. He has not gone anywhere.`;
  if (mins < 60 * 12) {
    const hrs = Math.round(mins / 60);
    return hrs < 1 ? `You were last up ${mins} minutes ago.` : `You were last up about ${hrs} hour${hrs === 1 ? '' : 's'} ago.`;
  }
  const days = Math.round(mins / (60 * 24));
  return days <= 1 ? 'You were last up yesterday.' : `You were last up ${days} days ago.`;
}

/**
 * The boot instruction.
 *
 * ⚠ ONE sentence, and one carrier for it. This used to ask for a greeting AND a
 * `say` item, because a `say` is spoken in full while an ordinary reply is
 * excerpted — the second call was how you made sure the first was heard.
 * Speak-out removed that reason and exposed the cost: both lines reach the
 * speakers, so booting said the same thing three times ("I'm on Tulito, branch
 * main" · "Beth is online and ready" · "Ready when you are"). Everything below
 * adds MATERIAL for one sentence. Nothing below asks for a second one.
 */
/**
 * What the harness noticed about a repo that is not set up for it.
 *
 * These facts used to die in console lines nobody reads ("no .claude/DIRECTOR.md
 * — running as a generic director"). As kickoff MATERIAL they let the greeting
 * OFFER /director-skills with evidence — "you have 34 files in plans/ I can't
 * read" is a colleague; "want me to set up plans?" is a wizard.
 *
 * ⚠️ Offered ONCE, ever, per repo (the caller gates on OnboardingOffer). A
 * declined offer must never repeat; Danny can always invoke the skill himself.
 */
export type OnboardingFacts = {
  /** The repo has no .claude/DIRECTOR.md. */
  noGuide: boolean;
  /** Markdown files sitting in a plans-shaped directory the index read NOTHING from. */
  unreadPlans: { dir: string; count: number } | null;
};

/** Files that look like plans, in the default root, that the index cannot see. */
export function unreadPlanFiles(repo: string, indexed: number): OnboardingFacts['unreadPlans'] {
  if (indexed > 0) return null;
  try {
    const dir = path.join(repo, 'plans');
    const count = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md').length;
    return count ? { dir: 'plans/', count } : null;
  } catch {
    return null;
  }
}

/**
 * The once-ever gate, stored beside the greeting history for the same reason
 * the personal beat's lastBeatAt is stored: a fresh session cannot know what a
 * previous one already offered.
 */
export class OnboardingOffer {
  private file: string;

  constructor(cfg: HarnessConfig) {
    this.file = path.join(cfg.stateDir, 'onboarding.json');
  }

  offered(): boolean {
    try {
      return Boolean(JSON.parse(fs.readFileSync(this.file, 'utf8')).offeredAt);
    } catch {
      return false;
    }
  }

  markOffered() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ offeredAt: new Date().toISOString() }));
    } catch {
      /* a state dir we cannot write costs a repeat offer, not a boot */
    }
  }
}

export function kickoffPrompt(input: {
  now?: Date;
  repoName: string;
  snapshot: RepoSnapshot;
  live: WorkItem[];
  priors: Opening[];
  lastAt: number | null;
  /** Present only when the offer should be made THIS boot. See OnboardingOffer. */
  onboarding?: OnboardingFacts;
}): string {
  const now = input.now ?? new Date();
  const { snapshot: s } = input;
  const facts: string[] = [];
  facts.push(
    `- ${input.repoName}${s.branch ? `, on ${s.branch}` : ''}${
      s.dirty === null ? '' : s.dirty === 0 ? ', tree clean' : `, ${s.dirty} file${s.dirty === 1 ? '' : 's'} uncommitted`
    }`
  );
  if (s.lastCommit) facts.push(`- last commit ${s.lastCommit.age}: "${s.lastCommit.subject}"`);
  if (input.live.length) {
    const names = input.live.slice(0, 3).map((i) => `"${i.spoken}"`).join(', ');
    facts.push(`- ${input.live.length} in flight — ${names}${input.live.length > 3 ? ', and others' : ''}`);
  } else {
    facts.push('- nothing in flight');
  }
  facts.push(`- it is ${now.toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false })} where he is`);
  facts.push(`- ${sinceLine(now.getTime(), input.lastAt)}`);
  // ⚠️ Material, not a second instruction — the greeting stays ONE sentence,
  // and asking for two things is what once made booting speak three times.
  // The offer is a fact she may fold in, phrased with its evidence.
  if (input.onboarding?.unreadPlans) {
    facts.push(
      `- ${input.onboarding.unreadPlans.count} markdown file${input.onboarding.unreadPlans.count === 1 ? '' : 's'} sit in ${input.onboarding.unreadPlans.dir} that you cannot read as plans — /director-skills can diagnose why; you may offer it, once, if you fold it into your one sentence`
    );
  } else if (input.onboarding?.noGuide) {
    facts.push(
      '- this repo has no .claude/DIRECTOR.md and no plans the harness can see — /director-skills sets both up; you may offer it, once, if you fold it into your one sentence'
    );
  }

  const out = [
    'You just came online. Greet Danny in ONE short sentence — that sentence is the whole of it. Do not call the say tool, do not add a status report and do not add a closing line: everything you write here is read aloud, so a second line that repeats the first is simply heard twice.',
    '',
    'True right now, so you do not have to go and look (do not read this list back — it is material, not an agenda):',
    ...facts,
    '',
    'Open on ONE of those, or on none of them if something better is there. A bare "Morning." is a perfectly good greeting on a day when nothing has changed; so is a remark about the thing that HAS changed. Be the person who has already read the board, not the console banner in front of it.',
  ];

  if (input.priors.length) {
    out.push(
      '',
      'Your last openings here, newest first:',
      ...input.priors.map((p) => `- "${p.text}"`),
      // The whole point. Without this she cannot know she has a habit, because
      // the conversation that formed it is not in this one.
      'Do not reuse them. Not the words, not the rhythm, and not the same fact dressed differently — if your sentence could be swapped for one of those without anyone noticing, it is the wrong sentence. Vary the length too: they are not all one sentence long by nature, they are one sentence long by rut.'
    );
  }

  return out.join('\n');
}
