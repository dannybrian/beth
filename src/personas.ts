// Who the director IS, kept where a person belongs — on the machine.
//
// The harness has always supplied the ROLE and the bound repo the PERSON, via
// its own `.claude/DIRECTOR.md`. That is still true and still the default. What
// it could not express is the other axis: the same person across several repos,
// chosen rather than inherited from whichever directory you happened to open.
//
// ⚠️ A persona does NOT live in this repo, and the harness ships none — exactly
// as it ships no plans. Checking one in would mean editing the tool to hire a
// colleague, which is the same mistake as teaching the harness about a specific
// project. They live in ~/.director-harness/personas, beside the .env that
// already holds the machine-scoped things (one ElevenLabs account per Mac, and
// now one voice per person).
//
// Persona and DIRECTOR.md COMPOSE rather than compete: the persona says who she
// is, the repo says what this project needs from a director. A repo that insists
// on its own director still gets one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NAME_PATTERNS, UNNAMED } from './directorName.ts';

export type Persona = {
  /** Filename without .md — the identity used in state paths and the dropdown. */
  slug: string;
  /** What to call her. Frontmatter `name:`, else scraped from the guide. */
  name: string;
  /** ElevenLabs voice for this person. Absent falls back to the machine's. */
  voiceId?: string;
  /** The markdown that rides the system prompt, frontmatter removed. */
  guide: string;
};

export const HOME = path.join(os.homedir(), '.director-harness');
export const PERSONAS_DIR = path.join(HOME, 'personas');
/**
 * What she REMEMBERS, kept beside the definitions rather than under the repo.
 *
 * The point of a named person is that she is the same person wherever you work,
 * so her memory of Danny follows her rather than the directory. Deliberately a
 * sibling of `personas/` and not a subdirectory of it: everything in there is
 * hand-written and safe to edit, and this is not.
 */
export const PERSONA_STATE = path.join(HOME, 'persona-state');

/** The README written beside the first persona, because an empty directory teaches nothing. */
const README = `# Personas

One markdown file per director. The filename is the identity — \`beth.md\` is
\`beth\` — and the harness ships none, so everything here is yours.

    ---
    name: Beth
    voice: <elevenlabs voice id>
    ---

    You are **Beth**, the standing director on whatever project this harness is
    bound to. …

Both frontmatter keys are optional. With no \`name:\` the harness reads the name
out of the first "You are **X**" it finds, which is the same sentence a repo's
\`.claude/DIRECTOR.md\` already contains — so an existing DIRECTOR.md can simply
be copied here. With no \`voice:\` she speaks in the machine's HARNESS_VOICE_ID.

What she remembers about you lives in ../persona-state/<slug>/, which follows the
person rather than the repo. Nothing in that directory is hand-written.

A persona does not replace the bound repo's \`.claude/DIRECTOR.md\`; the two are
appended together. The persona says who she is, the repo says what it needs from
a director.
`;

/**
 * Create the directory the first time, with the README in it.
 *
 * Called at boot. Consistent with the state dir, which the config has always
 * created — and an empty `personas/` next to the `.env` is the one hint that
 * this exists at all.
 */
export function ensurePersonasDir() {
  try {
    if (fs.existsSync(PERSONAS_DIR)) return;
    fs.mkdirSync(PERSONAS_DIR, { recursive: true });
    fs.writeFileSync(path.join(PERSONAS_DIR, 'README.md'), README);
  } catch {
    /* a machine dir we cannot write is a harness with no personas, not a failure */
  }
}

/**
 * Frontmatter, in the narrow form this needs.
 *
 * Not the plans reader's parser: that one belongs to a format the PROJECT owns
 * and answers to `/tidyrepo`. This reads two optional keys out of a file only
 * this harness will ever write, and a missing block is the ordinary case.
 */
export function parsePersona(slug: string, raw: string): Persona {
  let body = raw;
  const keys: Record<string, string> = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line.trim());
      if (kv) keys[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  const guide = body.trim();
  return {
    slug,
    // Declared, else the sentence her guide already contains, else unnamed —
    // which is a legitimate outcome here exactly as it is for a repo's guide.
    name: keys.name || scrapeName(guide),
    ...(keys.voice ? { voiceId: keys.voice } : {}),
    guide,
  };
}

function scrapeName(guide: string): string {
  for (const re of NAME_PATTERNS) {
    const found = re.exec(guide);
    if (found) return found[1];
  }
  return UNNAMED;
}

/** Every persona on this machine, by name. README.md is documentation, not a person. */
export function listPersonas(): Persona[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(PERSONAS_DIR);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .map((f) => readPersona(f.slice(0, -3)))
    .filter((p): p is Persona => Boolean(p))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readPersona(slug: string): Persona | null {
  // ⚠️ A slug reaches this from a POST body. It names a file, so it may not
  // contain a path — loopback is not a reason to let one read ../../.ssh/id_rsa.
  if (!/^[a-zA-Z0-9._-]+$/.test(slug) || slug.startsWith('.')) return null;
  try {
    return parsePersona(slug, fs.readFileSync(path.join(PERSONAS_DIR, `${slug}.md`), 'utf8'));
  } catch {
    return null;
  }
}

/** Where this persona's memory lives. Created on demand, like the repo state dir. */
export function personaStateDir(slug: string): string {
  const dir = path.join(PERSONA_STATE, slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Carry an existing memory across, ONCE, when the persona is the person the repo
 * already had.
 *
 * Without this, the first time Danny picks "Beth" in a repo whose DIRECTOR.md
 * already made her Beth, she forgets everything she knew about him — which is
 * the single worst thing this change could do, and it would look like the
 * feature working.
 *
 * ⚠️ Gated on the NAME matching. Choosing a different director must start a
 * different relationship: handing Alex a file of things Beth was told about him
 * is not continuity, it is a stranger who has read your diary. And it COPIES —
 * the repo's file stays where it is, so nothing is lost if he switches back.
 */
export function seedMemory(slug: string, personaName: string, repoDirector: string, repoStateDir: string) {
  if (!personaName || personaName === UNNAMED || personaName !== repoDirector) return;
  const dir = personaStateDir(slug);
  for (const f of ['personal.jsonl', 'personal-state.json']) {
    const to = path.join(dir, f);
    const from = path.join(repoStateDir, f);
    try {
      if (!fs.existsSync(to) && fs.existsSync(from)) fs.copyFileSync(from, to);
    } catch {
      /* a memory we cannot copy is a memory she starts without, not a failed boot */
    }
  }
}

/**
 * Which persona is in force in THIS repo.
 *
 * The choice is per-repo even though the person is not: "who am I talking to
 * about beadgame" is a property of the work, and answering it once per repo is
 * the whole convenience. Stored beside the pins, for the same reason — it is one
 * person's preference on one machine.
 */
export class PersonaChoice {
  private file: string;
  private slug = '';

  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'persona.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof raw?.slug === 'string') this.slug = raw.slug;
    } catch {
      /* no choice yet — the repo's own DIRECTOR.md is the default and always was */
    }
  }

  /** The chosen slug, or '' for "whatever the repo says". */
  chosen = () => this.slug;

  /** Resolves to a persona, or null when nothing is chosen or the file has gone. */
  current(): Persona | null {
    return this.slug ? readPersona(this.slug) : null;
  }

  set(slug: string) {
    this.slug = slug;
    try {
      fs.writeFileSync(this.file, JSON.stringify({ slug }, null, 2));
    } catch {
      /* the choice still holds for this run; it just will not survive a restart */
    }
  }
}
