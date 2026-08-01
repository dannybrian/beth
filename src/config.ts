// Instance configuration. One instance binds to ONE repo; every piece of state
// is keyed under that repo so several instances can run side by side.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type HarnessConfig = {
  /** The bound project repo — the director session's cwd. */
  repo: string;
  port: number;
  /**
   * Interface the UI and API listen on. LOOPBACK BY DEFAULT, and that is a
   * security boundary, not a detail: the tunnel forwards every path, so a
   * publicly-bound API means anyone holding the tunnel URL can read /api/state
   * and post turns as Danny. Set HARNESS_BIND=0.0.0.0 to expose it on the LAN
   * deliberately — never point a tunnel at it.
   */
  bind: string;
  /**
   * Separate public port carrying ONLY the Speech Engine websocket. This is the
   * one the tunnel points at, so nothing but an ElevenLabs-authenticated upgrade
   * is reachable from outside this machine.
   */
  voicePort: number;
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
  /** Voice is optional — absent credentials degrade the harness to text-only. */
  elevenLabsApiKey?: string;
  speechEngineId?: string;
  /**
   * Publicly reachable wss:// URL for THIS process, ending in the voice path.
   * ElevenLabs dials in to us, so localhost is not reachable — this is a tunnel
   * hostname. When set, the harness re-registers it on the engine at boot, which
   * is what makes a rotating tunnel URL survivable.
   */
  publicWsUrl?: string;
  /**
   * Whether the configured Speech Engine's TTS model understands v3 audio tags.
   * Realtime engines often run Flash/Turbo for latency, which may not. When false,
   * tags are stripped from the voice path too, so the voice never reads them aloud.
   */
  audioTagsSupported: boolean;
  /**
   * Reasoning effort applied for the life of a voice session, then restored.
   * Spoken conversation trades depth for latency; typed work keeps full effort.
   * Set HARNESS_VOICE_EFFORT=off to disable the switch entirely.
   */
  voiceEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  /**
   * How long a spoken turn may stay silent before Beth says "let me check".
   * The filler marks LATENESS — if the real answer lands inside this window it is
   * never spoken, so quick replies are not prefaced with a stall.
   */
  fillerDelayMs: number;
  /**
   * How long the transcript must stop changing before a spoken turn is started.
   *
   * ElevenLabs delivers a growing utterance as SEVERAL transcripts while you are
   * still talking. Acting on each one starts a separate director turn, so one
   * sentence became five. Raise this if turns still fire mid-sentence; lower it
   * if the reply feels sluggish.
   */
  voiceSettleMs: number;
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
   * secrets. There is one ElevenLabs account, one Speech Engine and one tunnel
   * hostname for this Mac — requiring a copy in every repo's .env duplicated the
   * same key N times, which is both tedious and a worse place to leave a secret.
   * Binding to a second repo silently produced a text-only harness, with the
   * only symptom being a caution icon after speaking.
   *
   * A repo can still override any of it — a project with its own engine just
   * sets the key locally and wins.
   */
  const env = readEnvFile(path.join(repo, '.env'));
  const machine = readEnvFile(MACHINE_ENV_FILE);
  const conf = (key: string) => process.env[key] ?? env[key] ?? machine[key];

  const port = Number(process.env.HARNESS_PORT ?? 4620);

  return {
    repo,
    port,
    bind: process.env.HARNESS_BIND ?? '127.0.0.1',
    voicePort: Number(process.env.HARNESS_VOICE_PORT ?? port + 1),
    claudeBin: conf('HARNESS_CLAUDE_BIN') ?? path.join(os.homedir(), '.local/bin/claude'),
    stateDir,
    eventLogPath: path.join(repo, '.claude', 'events.jsonl'),
    // Read from the bound repo's .env like every other setting. It was
    // process.env only, so a non-beadgame repo needed a shell wrapper to export
    // it — and the default below is beadgame's own plan path, which is exactly
    // the project-specific knowledge this harness is not supposed to hold. Set
    // HARNESS_DIRECTOR_PLAN in each repo's .env and the default stops mattering.
    directorPlan:
      conf('HARNESS_DIRECTOR_PLAN') ?? 'plans/2026-07-30-director-consolidation.md',
    planRoots: (conf('HARNESS_PLAN_ROOTS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    model: conf('HARNESS_MODEL') ?? DEFAULT_MODEL,
    elevenLabsApiKey: conf('ELEVENLABS_API_KEY'),
    speechEngineId: conf('SPEECH_ENGINE_ID'),
    publicWsUrl: conf('HARNESS_PUBLIC_WS_URL'),
    audioTagsSupported: conf('HARNESS_AUDIO_TAGS') !== '0',
    voiceEffort:
      conf('HARNESS_VOICE_EFFORT') === 'off'
        ? null
        : ((conf('HARNESS_VOICE_EFFORT') ?? 'low') as HarnessConfig['voiceEffort']),
    fillerDelayMs: Number(conf('HARNESS_FILLER_DELAY_MS') ?? 1500),
    // 900ms was still firing mid-sentence: an ordinary pause for breath, or an
    // "uh", outlasts it. Cutting a turn early is far worse than answering a beat
    // later — it asks half a question and then asks the rest as a second turn.
    voiceSettleMs: Number(conf('HARNESS_VOICE_SETTLE_MS') ?? 1800),
  };
}
