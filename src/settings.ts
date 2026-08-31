// The dials Danny sets from the page and expects to still be there tomorrow.
//
// Config has three READ-ONLY layers (real env → the repo's .env → the machine
// file). This is the first thing that WRITES one, so it is worth being explicit
// about where and why:
//
//   - It writes to the per-repo STATE DIR, beside tests.json and pins.json.
//     Nothing of the project's is edited. A setting made here is this machine's
//     opinion about this repo, which is exactly what the state dir is for, and a
//     harness that quietly rewrote a repo's .env would be a second writer nobody
//     asked for (the same rule that keeps plan files to one).
//
//   - It WINS over the env layers and over detection. The alternative — env
//     first — means a value you typed into the page silently does nothing
//     whenever the repo happens to set one, and a no-op with no symptom is the
//     worst failure this harness has. The page says where the live value came
//     from instead, and clearing the box hands it straight back.
//
// Only what a page can set belongs here. Secrets do not: they stay in the .env
// layers, where they are not one click from being rewritten.
import fs from 'node:fs';
import path from 'node:path';
import type { HarnessConfig } from './config.ts';

/** Every key is optional and absent means "no opinion" — never an empty string. */
export type StoredSettings = {
  /** Overrides HARNESS_TEST_CMD and detection. */
  testCmd?: string;
  /** Overrides HARNESS_BUILD_CMD and detection. */
  buildCmd?: string;
};

const KEYS: (keyof StoredSettings)[] = ['testCmd', 'buildCmd'];

export class Settings {
  private file: string;
  private values: StoredSettings = {};

  constructor(cfg: Pick<HarnessConfig, 'stateDir'>) {
    this.file = path.join(cfg.stateDir, 'settings.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const k of KEYS) {
        const v = raw?.[k];
        if (typeof v === 'string' && v.trim()) this.values[k] = v.trim();
      }
    } catch {
      /* nothing set here yet, or a file we cannot read — defaults are the answer */
    }
  }

  all(): StoredSettings {
    return { ...this.values };
  }

  get(key: keyof StoredSettings): string | undefined {
    return this.values[key];
  }

  /**
   * Set one, or clear it with an empty value.
   *
   * Clearing is a real gesture rather than an omission: it is how you hand a
   * command back to the env layer or to detection, so it must be expressible.
   */
  set(key: keyof StoredSettings, value: string | null | undefined): StoredSettings {
    const clean = (value ?? '').trim();
    if (clean) this.values[key] = clean;
    else delete this.values[key];
    this.save();
    return this.all();
  }

  private save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2));
    } catch {
      /* a state dir we cannot write is not worth failing a click over — the
         setting still applies to the running harness, it just will not survive
         a restart, and the alternative is a control that appears broken */
    }
  }
}
