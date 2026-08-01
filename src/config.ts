// Instance configuration. One instance binds to ONE repo; every piece of state
// is keyed under that repo so several instances can run side by side.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type HarnessConfig = {
  /** The bound project repo — the director session's cwd. */
  repo: string;
  port: number;
  /** Native CLI binary. The SDK's bundled Bun build hangs under Rosetta here. */
  claudeBin: string;
  /** Per-repo state (session id for resume). Never machine-global. */
  stateDir: string;
  /** Append-only event log inside the bound repo, gitignored. */
  eventLogPath: string;
  /** Plan whose live claim means a terminal director already holds the role. */
  directorPlan: string;
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
};

// The director session runs all day and every turn carries full repo context, so
// the model choice is the dominant cost lever. Opus is the deliberate default;
// override with HARNESS_MODEL when a turn genuinely needs more.
const DEFAULT_MODEL = 'claude-opus-5';

const slug = (p: string) => p.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Read secrets from the BOUND REPO's .env, so a key already sitting in the
 * project (alongside REPLICATE_API_TOKEN and friends) is found without a second
 * copy. Real environment variables always win. Minimal parser on purpose — this
 * needs KEY=value and nothing else.
 */
function repoEnv(repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  const file = path.join(repo, '.env');
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

export function loadConfig(): HarnessConfig {
  const repo = path.resolve(process.env.HARNESS_REPO ?? path.join(os.homedir(), 'Sources/beadgame'));
  if (!fs.existsSync(path.join(repo, '.claude'))) {
    throw new Error(`Bound repo has no .claude directory: ${repo}`);
  }
  const stateDir = path.join(os.homedir(), '.director-harness', slug(repo));
  fs.mkdirSync(stateDir, { recursive: true });
  const env = repoEnv(repo);

  return {
    repo,
    port: Number(process.env.HARNESS_PORT ?? 4620),
    claudeBin: process.env.HARNESS_CLAUDE_BIN ?? path.join(os.homedir(), '.local/bin/claude'),
    stateDir,
    eventLogPath: path.join(repo, '.claude', 'events.jsonl'),
    directorPlan: process.env.HARNESS_DIRECTOR_PLAN ?? 'plans/2026-07-30-director-consolidation.md',
    model: process.env.HARNESS_MODEL ?? DEFAULT_MODEL,
    elevenLabsApiKey: process.env.ELEVENLABS_API_KEY ?? env.ELEVENLABS_API_KEY,
    speechEngineId: process.env.SPEECH_ENGINE_ID ?? env.SPEECH_ENGINE_ID,
    publicWsUrl: process.env.HARNESS_PUBLIC_WS_URL ?? env.HARNESS_PUBLIC_WS_URL,
    audioTagsSupported: process.env.HARNESS_AUDIO_TAGS !== '0',
    voiceEffort:
      process.env.HARNESS_VOICE_EFFORT === 'off'
        ? null
        : ((process.env.HARNESS_VOICE_EFFORT ?? 'low') as HarnessConfig['voiceEffort']),
  };
}
