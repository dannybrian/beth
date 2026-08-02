// The words a recogniser gets wrong, handed to it in advance.
//
// A conversation about a project is made mostly of project nouns — `pnpm`,
// `colyseus`, `Music.Core` — and those are exactly what a general recogniser has
// never heard. It does not fail loudly either: it substitutes the nearest real
// word, so "colyseus" comes back "colossus" and the sentence still parses.
//
// The Web Speech API grew contextual biasing (`phrases`, boosted) after the voice
// plane was written, which is the same mechanism ElevenLabs calls `keyterms`. It
// biases toward a token — it does not teach spelling — so everything here is a
// SPOKEN form: "Music Core", not "Music.Core", because the dot is not a sound.
//
// Sources, in priority order. The harness stays project-agnostic: it knows how to
// mine a repo, never what any particular repo contains.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Ordinary words that a recogniser already knows, and generic packaging noise.
 * Biasing these buys nothing and costs precision — every boosted term is a term
 * the recogniser is readier to hear where it was not said.
 */
const NOISE = new Set([
  'types', 'node', 'sdk', 'cli', 'js', 'ts', 'lib', 'libs', 'src', 'app', 'apps',
  'test', 'tests', 'utils', 'util', 'common', 'shared', 'server', 'client', 'web',
  'api', 'core', 'main', 'index', 'config', 'scripts', 'tools', 'docs', 'plans',
  'dist', 'build', 'public', 'assets', 'bin', 'temp', 'tmp', 'old', 'new',
]);

/** Directories that are never a project's own vocabulary. */
const SKIP_DIR = /^(\.|node_modules$|dist$|build$|out$|bin$|obj$|coverage$|vendor$|target$)/;

/**
 * A phrase list long enough to cover a project and short enough that the
 * recogniser is still listening to the person rather than to the list. ElevenLabs
 * caps its own keyterms at 50; Chrome documents no limit, so this is a judgement
 * rather than a constraint — and what falls off the end is LOGGED, never dropped
 * silently.
 */
export const MAX_TERMS = 60;

/**
 * "Music.Core" → "Music Core", "lexicon-factory" → "lexicon factory",
 * "LiveAudition" → "Live Audition". Separators and case boundaries are both word
 * breaks, because neither is a SOUND — he says "live audition".
 */
const spokenForm = (raw: string): string =>
  raw
    .replace(/[._\-/]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * A phrase is a TERM, not a sentence. Plan names run to "Port the beadgame plans
 * workflow + director mode to Tulito", and biasing toward a whole sentence biases
 * toward nothing — the words in it are ordinary and the sentence will never be
 * said twice the same way.
 */
const MAX_WORDS = 4;

/** Worth boosting: not noise, not a single letter, not a number, not a sentence. */
const worthIt = (term: string): boolean => {
  const words = term.toLowerCase().split(' ').filter(Boolean);
  if (!words.length || words.length > MAX_WORDS) return false;
  if (term.length < 3) return false;
  if (/^\d+$/.test(term)) return false;
  // Every word generic means the phrase is generic — "src utils" teaches nothing.
  return !words.every((w) => NOISE.has(w));
};

/**
 * Third-party nouns: the dependency names of every package.json in the repo.
 *
 * Scoped packages give the SCOPE (`@colyseus/sdk` → colyseus) — that is the word
 * he says out loud. Everything else gives the first segment (`pino-pretty` →
 * pino), because the suffix is packaging and the stem is the noun.
 */
export function dependencyTerms(repo: string, depth = 3): string[] {
  const out: string[] = [];
  const walk = (dir: string, left: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && left > 0 && !SKIP_DIR.test(e.name)) walk(path.join(dir, e.name), left - 1);
      if (!e.isFile() || e.name !== 'package.json') continue;
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8'));
        for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
          for (const name of Object.keys(pkg[field] ?? {})) {
            out.push(name.startsWith('@') ? name.slice(1).split('/')[0] : name.split('-')[0]);
          }
        }
      } catch {
        /* an unreadable or half-written package.json is not worth a word about */
      }
    }
  };
  walk(repo, depth);
  return out;
}

/**
 * First-party nouns: the names of the sub-projects.
 *
 * One rule for every ecosystem rather than a reader per language — the
 * directories under the repo's own top level are what its parts are CALLED, in
 * .NET (`src/Music.Notation`) exactly as in a pnpm workspace
 * (`apps/lexicon-factory`). A trailing "Tests" is dropped so a test project does
 * not spend a slot restating the thing it tests.
 *
 * ⚠️ COMPOUND NAMES ONLY, and that rule is doing real work. A directory called
 * `Music.Core` or `lexicon-factory` is a made-up name and worth boosting; one
 * called `notes`, `future` or `mockups` is an ordinary English word the
 * recogniser already knows, and boosting it only makes the recogniser readier to
 * hear it where it was not said. Nothing structural separates "colyseus" from
 * "mockups" — only a dictionary would, and a dictionary is not worth shipping —
 * so the auto-derived half stays conservative and `HARNESS_KEYTERMS` carries
 * anything single-worded that matters.
 */
export function projectTerms(repo: string): string[] {
  const out: string[] = [];
  let tops: fs.Dirent[];
  try {
    tops = fs.readdirSync(repo, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const top of tops) {
    if (!top.isDirectory() || SKIP_DIR.test(top.name)) continue;
    let kids: fs.Dirent[];
    try {
      kids = fs.readdirSync(path.join(repo, top.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const kid of kids) {
      if (!kid.isDirectory() || SKIP_DIR.test(kid.name)) continue;
      const term = spokenForm(kid.name).replace(/\s+Tests$/i, '');
      if (term.includes(' ')) out.push(term);
    }
  }
  return out;
}

/**
 * Everything, deduplicated case-insensitively, in priority order.
 *
 * CONFIGURED TERMS COME FIRST and are never the ones dropped: they are the only
 * source with a person behind them, and the only place a noun that appears in no
 * file — a customer, a piece of jargon, a person's name — can come from at all.
 */
export function keyterms(input: {
  configured?: string[];
  /** Spoken names of the work in flight — what he is actually talking about. */
  live?: string[];
  /** Pre-mined repo vocabulary. See mineRepo — it walks the tree, so it is done
   *  once at boot rather than on every page that connects. */
  mined?: string[];
  max?: number;
}): { terms: string[]; dropped: number } {
  const max = input.max ?? MAX_TERMS;
  // ⚠️ CONFIGURED TERMS ARE VERBATIM. `spokenForm` exists to turn a FILENAME into
  // something sayable; running it over what he typed silently rewrote "SkiaSharp"
  // to "Skia Sharp" — which may even be the better phrase, but it is his call and
  // he is the one who can hear the result. Only derived names get normalised.
  const raw: [string, boolean][] = [
    ...(input.configured ?? []).map((t) => [t, true] as [string, boolean]),
    ...[...(input.live ?? []), ...(input.mined ?? [])].map((t) => [t, false] as [string, boolean]),
  ];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const [r, verbatim] of raw) {
    const term = verbatim ? String(r).trim() : spokenForm(String(r));
    const key = term.toLowerCase();
    if (!term || seen.has(key) || !worthIt(term)) continue;
    seen.add(key);
    terms.push(term);
  }
  return { terms: terms.slice(0, max), dropped: Math.max(0, terms.length - max) };
}

/** Everything the repo itself can tell us. Walks the tree — call it once. */
export const mineRepo = (repo: string): string[] => [...projectTerms(repo), ...dependencyTerms(repo)];

/** `HARNESS_KEYTERMS=pnpm, colyseus, Music Core` — commas, spaces allowed inside. */
export const parseKeyterms = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
