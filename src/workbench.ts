// The workbench — ONE url, boldly on the page: the thing being iterated on
// right now. A dev server, a staging deploy, a PR. Not a bookmark list on
// purpose: the moment it holds two, it answers "what are we working on?" with
// "you choose", which is the question it exists to close.
//
// Like a pin (pins.ts), it is attention, not a fact about the work — so it
// lives in the state dir, per repo, and no project file learns about it. Unlike
// a pin it survives a restart on purpose: the dev server it points at usually
// outlives the harness process that pinned it.
import fs from 'node:fs';
import path from 'node:path';
import type { HarnessConfig } from './config.ts';

export type BenchState = { url: string; label?: string; setAt: string } | null;

export type BenchMessage = { type: 'workbench'; url: string | null; label?: string };

/**
 * Only a url the page can safely hand to an <a href>. The bench renders in
 * every open tab straight off the bus, so a `javascript:` url pinned by a
 * confused tool call would put an executable link in the boldest spot on the
 * page. http(s) only; anything else is refused with the reason.
 */
export function vetBenchUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  const parse = (s: string) => {
    try {
      return new URL(s);
    } catch {
      return null;
    }
  };
  const direct = parse(trimmed);
  if (direct && (direct.protocol === 'http:' || direct.protocol === 'https:')) return { ok: true, url: direct.href };
  // "localhost:3000" is the most natural thing to hand this, and the parser
  // reads it as scheme `localhost:` — so anything without an explicit
  // `scheme://` gets one try as http before being refused. `javascript:` and
  // friends cannot ride this in: http-prefixed they fail to parse (the colon
  // lands in the port), and un-prefixed they fall through to the refusal below.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const retried = parse(`http://${trimmed}`);
    if (retried) return { ok: true, url: retried.href };
  }
  if (direct) return { ok: false, reason: `only http(s) can be pinned, not ${direct.protocol}` };
  return { ok: false, reason: `not a url: ${trimmed || '(empty)'} — e.g. http://localhost:3000` };
}

export class Workbench {
  private file: string;
  private state: BenchState = null;

  constructor(cfg: Pick<HarnessConfig, 'stateDir'>) {
    this.file = path.join(cfg.stateDir, 'workbench.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // Re-vet on load: the file is ours, but "we wrote it" is a weaker proof
      // than the one the page relies on, and vetting twice costs nothing.
      if (raw && typeof raw.url === 'string' && vetBenchUrl(raw.url).ok) {
        this.state = {
          url: raw.url,
          label: typeof raw.label === 'string' && raw.label ? raw.label : undefined,
          setAt: typeof raw.setAt === 'string' ? raw.setAt : new Date().toISOString(),
        };
      }
    } catch {
      /* nothing on the bench yet — the right start */
    }
  }

  current(): BenchState {
    return this.state ? { ...this.state } : null;
  }

  set(rawUrl: string, label?: string): { ok: true; state: NonNullable<BenchState> } | { ok: false; reason: string } {
    const vetted = vetBenchUrl(rawUrl);
    if (!vetted.ok) return vetted;
    const trimmed = label?.trim();
    this.state = { url: vetted.url, label: trimmed || undefined, setAt: new Date().toISOString() };
    this.save();
    return { ok: true, state: { ...this.state } };
  }

  /** Returns what was cleared, so the caller can say so. */
  clear(): BenchState {
    const was = this.state;
    this.state = null;
    this.save();
    return was;
  }

  /** The bus message — one shape whether occupied or empty, so the page has one handler. */
  message(): BenchMessage {
    return { type: 'workbench', url: this.state?.url ?? null, label: this.state?.label };
  }

  private save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    } catch {
      /* a bench that forgets on restart beats a harness that will not run */
    }
  }
}
