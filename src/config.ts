// Instance configuration. One instance binds to ONE repo; every piece of state
// is keyed under that repo so several instances can run side by side.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { directorName } from './directorName.ts';
import { SPEECH_LEVELS, type SpeechLevel } from './spoken.ts';
import { parseKeyterms } from './keyterms.ts';

/**
 * How hard the model thinks. `null` is the model's own default rather than a
 * level of its own, which is why it is in the type: "leave it alone" has to be
 * expressible both as the config and as a choice in the UI.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number] | null;

export type HarnessConfig = {
  /** The bound project repo — the director session's cwd. */
  repo: string;
  port: number;
  /**
   * Interface everything listens on. LOOPBACK BY DEFAULT, and now that is the
   * WHOLE security story rather than half of it: there is no second listener and
   * nothing dials in, so every byte of this harness — the API, the audio, the
   * shell-executing handoff — is unreachable from off this machine by
   * construction. Set HARNESS_BIND=0.0.0.0 to expose it on the LAN deliberately.
   */
  bind: string;
  /** Native CLI binary. The SDK's bundled Bun build hangs under Rosetta here. */
  claudeBin: string;
  /** Per-repo state (session id for resume). Never machine-global. */
  stateDir: string;
  /** Append-only event log inside the bound repo, gitignored. */
  eventLogPath: string;
  /** Plan whose live claim means a terminal director already holds the role. */
  directorPlan: string;
  /**
   * Where this project's plans live, repo-relative. Normally EMPTY: the reader
   * defers to the project's own index and falls back to finding directories named
   * `plans`. Set HARNESS_PLAN_ROOTS only for a repo that keeps them somewhere the
   * reader cannot find on its own.
   */
  planRoots: string[];
  model: string;
  /**
   * How tool permissions are resolved, using the SDK's own modes:
   *   'auto'        — a model classifier settles the ordinary ones and escalates
   *                   only what it will not take on itself
   *   'default'     — everything the settings files do not pre-approve asks
   *   'acceptEdits' — file edits go through; the rest still asks
   *   'dontAsk'     — never ask, and deny anything not pre-approved
   *
   * 'auto' is the default because an approval card is UNANSWERABLE BY VOICE: the
   * director stops mid-job and the only tell is silence, which is
   * indistinguishable from a hang. The card still appears for
   * whatever the classifier escalates, which is where the repo's own prod-safety
   * rules land.
   *
   * 'bypassPermissions' is deliberately not offered: it needs the SDK's
   * allowDangerouslySkipPermissions and it would delete the seam the bound repo's
   * "production needs a per-action yes" rule depends on.
   */
  permissionMode: 'default' | 'auto' | 'acceptEdits' | 'dontAsk';
  /**
   * What to call the director in the UI's own words ("Beth wants to use Bash").
   * Read from the bound repo's .claude/DIRECTOR.md, because the person is the
   * project's to supply; HARNESS_DIRECTOR_NAME overrides a repo that phrases its
   * identity somewhere the reader cannot see.
   */
  directorName: string;
  /** Voice is optional — absent credentials degrade the harness to text-only. */
  elevenLabsApiKey?: string;
  /**
   * A Speech Engine is no longer used to speak or to listen. It survives as ONE
   * thing: somewhere to read a voice id from, so an existing setup keeps sounding
   * like the same person without anyone copying an id around. HARNESS_VOICE_ID
   * makes it unnecessary.
   */
  speechEngineId?: string;
  /**
   * Whose voice she speaks in. Read off the Speech Engine when absent, so the two
   * paths sound like the same person — the IDENTITY is worth inheriting even
   * though the model below is not.
   */
  voiceId?: string;
  /**
   * TTS model for the speak-out path, which is NOT the engine's.
   * `eleven_v3_conversational` is rejected by the standalone endpoint (tried
   * 2026-08-01), and realtime models are the ones tuned for first-byte latency,
   * which is what matters when she is talking to you.
   */
  ttsModel: string;
  /**
   * What a thousand ElevenLabs credits cost YOU, for the estimate in the stats
   * panel. There is no API that hands us this: credits-per-character comes from
   * the model, but dollars-per-credit comes from the plan, and the two together
   * are the bill. The default is the Creator plan ($22 / 100k credits); Pro and
   * Scale are cheaper per credit, so set this and the panel stops lying to you.
   * It is only ever multiplied into a displayed estimate — nothing is enforced.
   */
  ttsUsdPer1kCredits: number;
  /**
   * How much of what she writes is read ALOUD. The transcript always has all of
   * it; this only decides what is pronounced.
   *   'full'      — every line, as it was before this existed
   *   'brief'     — `say` items in full, and the LAST PARAGRAPH of a longer reply
   *   'headlines' — findings, events, and short in-progress lines only
   *
   * 'brief' is the default because the two channels have different budgets: six
   * paragraphs of real code work is a few seconds of skimming on the page and a
   * minute and a half of unskippable audio. See src/spoken.ts.
   */
  speechLevel: SpeechLevel;
  /**
   * Bias the recogniser toward this project's own nouns (`keyterms.ts`).
   *
   * OFF by default, and deliberately: contextual biasing arrived in the Web
   * Speech API after this harness was written, it may require Chrome's on-device
   * model, and a recogniser that refuses to start is a mic that does nothing. The
   * page falls back to unbiased recognition rather than failing, but the default
   * stays off until it has been used in anger.
   */
  speechBiasing: boolean;
  /**
   * Nouns no file mentions — jargon, customers, people. Never dropped by the cap,
   * and the ONE setting that accumulates across the config layers rather than
   * overriding: machine-wide tools plus this repo's own words. See confAll.
   */
  keyterms: string[];
  /**
   * How hard to push. Chrome takes 0–10 with 1 as neutral; the cost of pushing
   * harder is hearing the term where it was not said, so this is a knob rather
   * than a setting to get right once.
   */
  keytermBoost: number;
  /**
   * Reasoning effort applied while the MIC IS OPEN, then restored.
   *
   * Spoken conversation trades depth for latency; typed work keeps full effort.
   * It used to hang off the paid session opening and closing; with no session to
   * hang off, the mic being on is the signal — which is what it always meant.
   * Set HARNESS_VOICE_EFFORT=off to disable the switch entirely.
   */
  voiceEffort: EffortLevel;
  /**
   * How long the words must stop CHANGING before a spoken turn is sent. Served
   * to the page, which is where the window now lives.
   *
   * A recogniser revises as you speak, and acting on each revision starts a
   * separate director turn — one sentence became five. Note the rule is about the
   * WORDS changing, not about events arriving: see ui/listen.js. Raise this if
   * turns still fire mid-sentence; lower it if replies feel sluggish.
   */
  voiceSettleMs: number;
  /**
   * What to run to answer "is the tree green". Empty means DETECT it — see
   * testRunner.ts, which reads what the project already declares.
   *
   * ⚠️ Split on whitespace and spawned directly; nothing here reaches a shell. A
   * command that genuinely needs shell syntax should be a script the project has.
   */
  /**
   * Whether she remembers the PERSON between sessions. Off means genuinely off:
   * no tools registered, nothing recorded, nothing in the prompt — because
   * someone who disables this is saying don't keep a file on me, not "ask me less
   * often". HARNESS_PERSONAL=off.
   */
  personal: boolean;
  testCmd?: string;
  /** How still the tree must be first — a suite run against a half-finished edit
   * is a red light that means nothing. */
  testSettleMs: number;
  /** Floor between runs, so a rapid series of saves does not queue one each. */
  testMinIntervalMs: number;
  /** After this the run is killed and REPORTED as timed out, not left hanging. */
  testTimeoutMs: number;
};

// The director session runs all day and every turn carries full repo context, so
// the model choice is the dominant cost lever. Opus is the deliberate default;
// override with HARNESS_MODEL when a turn genuinely needs more.
const DEFAULT_MODEL = 'claude-opus-5';

const slug = (p: string) => p.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Read KEY=value from a .env-style file. Minimal on purpose — this needs
 * KEY=value and nothing else.
 */
function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Machine-wide harness config, beside the per-repo state directories. */
export const MACHINE_ENV_FILE = path.join(os.homedir(), '.director-harness', '.env');

export function loadConfig(): HarnessConfig {
  const repo = path.resolve(process.env.HARNESS_REPO ?? path.join(os.homedir(), 'Sources/beadgame'));
  if (!fs.existsSync(path.join(repo, '.claude'))) {
    throw new Error(`Bound repo has no .claude directory: ${repo}`);
  }
  const stateDir = path.join(os.homedir(), '.director-harness', slug(repo));
  fs.mkdirSync(stateDir, { recursive: true });
  /**
   * THREE LAYERS, most specific first: real environment, then the bound repo's
   * .env, then a machine-wide file.
   *
   * The machine layer exists because the voice credentials are not project
   * secrets. There is one ElevenLabs account for this Mac — requiring a copy in
   * every repo's .env duplicated the same key N times, which is both tedious and
   * a worse place to leave a secret. Binding to a second repo silently produced a
   * text-only harness, with the only symptom being a caution icon after speaking.
   *
   * A repo can still override any of it — a project with its own engine just
   * sets the key locally and wins.
   */
  const env = readEnvFile(path.join(repo, '.env'));
  const machine = readEnvFile(MACHINE_ENV_FILE);
  const conf = (key: string) => process.env[key] ?? env[key] ?? machine[key];
  /**
   * The one key that ACCUMULATES instead of overriding.
   *
   * Vocabulary splits the same way the credentials do, only the other way up: the
   * tools he says on every repo (`pnpm`, `Claude Code`) belong to the machine, and
   * the project's own nouns belong to the repo. Under first-wins, a repo list
   * silently deletes the machine list — and the symptom would be "pnpm still comes
   * out wrong", with nothing pointing at why.
   */
  const confAll = (key: string) => [machine[key], env[key], process.env[key]].filter(Boolean).join(',');

  const port = Number(process.env.HARNESS_PORT ?? 4620);

  return {
    repo,
    port,
    bind: process.env.HARNESS_BIND ?? '127.0.0.1',
    claudeBin: conf('HARNESS_CLAUDE_BIN') ?? path.join(os.homedir(), '.local/bin/claude'),
    stateDir,
    eventLogPath: path.join(repo, '.claude', 'events.jsonl'),
    // Read from the bound repo's .env like every other setting. It was
    // process.env only, so a non-beadgame repo needed a shell wrapper to export
    // it — and the default below is beadgame's own plan path, which is exactly
    // the project-specific knowledge this harness is not supposed to hold. Set
    // HARNESS_DIRECTOR_PLAN in each repo's .env and the default stops mattering.
    // No default. This used to fall back to a beadgame path — the last
    // project-specific fact baked into the harness. A repo names its role-lock
    // plan in its own .env (/director-skills creates both); an empty value
    // means the repo has no lock and the role is simply free.
    directorPlan: conf('HARNESS_DIRECTOR_PLAN') ?? '',
    planRoots: (conf('HARNESS_PLAN_ROOTS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    model: conf('HARNESS_MODEL') ?? DEFAULT_MODEL,
    permissionMode: (conf('HARNESS_PERMISSION_MODE') ?? 'auto') as HarnessConfig['permissionMode'],
    directorName: directorName(repo, conf('HARNESS_DIRECTOR_NAME') ?? ''),
    elevenLabsApiKey: conf('ELEVENLABS_API_KEY'),
    speechEngineId: conf('SPEECH_ENGINE_ID'),
    voiceId: conf('HARNESS_VOICE_ID') ?? conf('ELEVENLABS_VOICE_ID'),
    ttsModel: conf('HARNESS_TTS_MODEL') ?? 'eleven_flash_v2_5',
    ttsUsdPer1kCredits: Number(conf('HARNESS_TTS_USD_PER_1K_CREDITS')) || 0.22,
    speechBiasing: (conf('HARNESS_SPEECH_BIASING') ?? 'off') === 'on',
    keyterms: parseKeyterms(confAll('HARNESS_KEYTERMS')),
    keytermBoost: Number(conf('HARNESS_KEYTERM_BOOST')) || 2,
    speechLevel: (SPEECH_LEVELS as string[]).includes(conf('HARNESS_SPEECH_LEVEL') ?? '')
      ? (conf('HARNESS_SPEECH_LEVEL') as SpeechLevel)
      : 'brief',
    voiceEffort:
      conf('HARNESS_VOICE_EFFORT') === 'off'
        ? null
        : ((conf('HARNESS_VOICE_EFFORT') ?? 'low') as HarnessConfig['voiceEffort']),
    // 900ms was still firing mid-sentence: an ordinary pause for breath, or an
    // "uh", outlasts it. Cutting a turn early is far worse than answering a beat
    // later — it asks half a question and then asks the rest as a second turn.
    // 1800 was still short for Danny in practice, so 2500: the cost of waiting is
    // a beat, and the cost of firing early is half a question.
    voiceSettleMs: Number(conf('HARNESS_VOICE_SETTLE_MS') ?? 2500),
    personal: conf('HARNESS_PERSONAL') !== 'off',
    testCmd: conf('HARNESS_TEST_CMD'),
    testSettleMs: Number(conf('HARNESS_TEST_SETTLE_MS') ?? 5000),
    testMinIntervalMs: Number(conf('HARNESS_TEST_MIN_INTERVAL_MS') ?? 120_000),
    testTimeoutMs: Number(conf('HARNESS_TEST_TIMEOUT_MS') ?? 300_000),
  };
}
