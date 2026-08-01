// Deriving a SPOKEN name for a work item — the half of a reference that makes
// pointing work. Danny clicks a plan; Beth has to be able to say what he clicked.
//
// This is fussier than it looks, and the fussiness is measured, not imagined.
// Across beadgame's 571 plans:
//
//   - Cutting a title at its first em-dash reads beautifully most of the time
//     ("Director consolidation", "Unity MCP Editor Bridge") …
//   - …but collapses 69 plans into COLLISIONS. Three separate in-flight plans
//     become "Viz sidecar"; others reduce to bare "Design" or "Spec".
//   - The FILENAME is frequently the better spoken form, because Danny named it:
//     `2026-07-15-viz-geography-delivery.md` → "viz geography delivery" — distinct,
//     sayable, and how he refers to it anyway.
//
// So this is not a formatter. It is a ladder of candidates plus collision
// resolution across the whole index: take the nicest name that is still unique,
// and escalate only the items that actually clash. Everything else keeps its
// good name.

/** Markdown noise that should never be spoken — nor shown in a 300px panel. */
export function stripMarkdown(raw: string): string {
  return raw
    .replace(/`+/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → their label
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanTitle(raw: string): string {
  return stripMarkdown(raw)
    .replace(/^#+\s*/, '')
    .replace(/[.,;:]+$/, '')
    .trim();
}

/**
 * Where a title stops being a name and starts being elaboration. Em-dash, colon,
 * comma and an opening paren all mark that boundary in practice; `+` and `&` do
 * NOT — "Menu Fluidity + Screen Revival" is one name, and cutting it reads wrong.
 */
const BREAK = /\s+[—–]\s+|:\s+|,\s+|\s+\(/;

/** The prose name: the title up to its first elaboration break. */
export function headline(title: string): string {
  const clean = cleanTitle(title);
  const cut = clean.split(BREAK)[0].trim().replace(/[.,;:]+$/, '');
  return cut || clean;
}

/**
 * The filename, made sayable: drop the date prefix, drop a leading issue number,
 * hyphens become spaces. `2026-07-30-174-menu-fluidity.md` → "menu fluidity".
 */
export function slugName(path: string): string {
  const base = (path.split('/').pop() ?? path).replace(/\.md$/i, '');
  return base
    .replace(/^\d{4}-\d{2}-\d{2}-/, '')
    .replace(/^\d+-/, '')
    .replace(/-/g, ' ')
    .trim();
}

/**
 * Words that must never END a spoken name. Truncating at a word boundary is not
 * enough: "…still holds the" is a clean boundary and still sounds like the
 * speaker was cut off mid-sentence. Ending on a content word sounds deliberate.
 */
const DANGLING = /(?:^|\s)(?:the|a|an|of|to|and|or|in|for|with|on|at|from|by|as|is|are|that|this|its|it)$/i;

/** A long name is a bad name to hear. Trim at a word boundary, never mid-word. */
export function capWords(s: string, max = 64): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  let out = (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[.,;:—–-]+$/, '').trim();
  // Peel trailing function words — repeatedly, since "…holds the" leaves "holds".
  while (DANGLING.test(out)) out = out.replace(DANGLING, '').trim();
  return out.replace(/[.,;:—–-]+$/, '').trim();
}

/** The directory a plan sits in, as words — the last-resort disambiguator. */
function whereWords(path: string): string {
  const parts = path.split('/').slice(0, -1);
  const dir = parts[parts.length - 1] ?? '';
  return dir.replace(/[-_]/g, ' ').trim();
}

/**
 * Names to try, best first. Rung 2 is the filename rather than a longer slice of
 * the title on purpose: when a title collides it is usually because its headline
 * is generic ("Viz sidecar", "Design"), and more of that same title tends to be
 * technical soup ("scores.regionality + resolved geo.pins"). The filename is
 * short, distinct, and already how Danny talks about the plan.
 */
export function spokenCandidates(title: string, path: string): string[] {
  const full = cleanTitle(title);
  const out = [headline(title), slugName(path), full, `${slugName(path)} in ${whereWords(path)}`];
  return out.map((c) => capWords(c)).filter((c, i, a) => c && a.indexOf(c) === i);
}

export type NameableItem = {
  title: string;
  path: string;
  /** An explicit `name:` from the item itself. Authoritative — see below. */
  name?: string;
};

/**
 * Assign a unique spoken name to every item.
 *
 * An EXPLICIT name always wins. Derivation is a good default, not a policy: when
 * Danny writes `name: the context diet` in a plan's frontmatter, that is the name,
 * uncapped and untouched. Everything below is what happens for the plans he has
 * not bothered to name — which is most of them, and always will be.
 *
 * Three properties matter, all tested:
 *   - EXPLICIT BEATS DERIVED — an explicit name is claimed before any derived
 *     name can take it, so naming one plan never gets quietly overridden by
 *     another plan's title.
 *   - STABILITY — the result depends only on the set of items, not their order,
 *     so a file save that re-reads the corpus does not rename things out from
 *     under a reference Danny is already holding in the composer.
 *   - NO SILENT DUPLICATES — the last rung appends a counter. Ugly, effectively
 *     unreachable, but a duplicate spoken name is a reference that resolves to
 *     the WRONG plan, which is worse than ugly.
 */
export function assignSpokenNames(items: NameableItem[]): Map<string, string> {
  // Sort by path so assignment is deterministic regardless of read order.
  const ordered = [...items].sort((a, b) => a.path.localeCompare(b.path));
  const ladders = new Map(ordered.map((i) => [i.path, spokenCandidates(i.title, i.path)]));

  const assigned = new Map<string, string>();
  const taken = new Map<string, string>(); // lowercased name → path that holds it

  // Explicit names first, before any derived name is in play. A second plan
  // claiming the SAME explicit name does not get it — it falls through to
  // derivation, and the index reports the conflict rather than mangling both.
  for (const i of ordered) {
    const explicit = cleanTitle(i.name ?? '');
    if (!explicit || taken.has(explicit.toLowerCase())) continue;
    assigned.set(i.path, explicit);
    taken.set(explicit.toLowerCase(), i.path);
  }

  let remaining = ordered.filter((i) => !assigned.has(i.path)).map((i) => i.path);

  // A short ladder keeps re-proposing its last rung; the counter fallback catches it.
  const rungAt = (p: string, rung: number) => {
    const ladder = ladders.get(p)!;
    return ladder[Math.min(rung, ladder.length - 1)];
  };
  const maxRungs = Math.max(1, ...[...ladders.values()].map((l) => l.length));

  for (let rung = 0; rung < maxRungs && remaining.length; rung++) {
    // Who wants which name at this rung. A name is only free for an item if no
    // OTHER unsettled item wants it too — that is what stops the alphabetically
    // first plan from grabbing a shared name and leaving its twin with a worse one.
    const wants = new Map<string, string[]>();
    for (const p of remaining) {
      const key = rungAt(p, rung).toLowerCase();
      if (taken.has(key)) continue; // a settled item already owns this name
      const list = wants.get(key);
      if (list) list.push(p);
      else wants.set(key, [p]);
    }

    const still: string[] = [];
    for (const p of remaining) {
      const name = rungAt(p, rung);
      if (wants.get(name.toLowerCase())?.length === 1) {
        assigned.set(p, name);
        taken.set(name.toLowerCase(), p);
      } else {
        still.push(p);
      }
    }
    remaining = still;
  }

  // Anything still unresolved genuinely exhausted its ladder: two items with the
  // same title in the same directory with the same filename shape.
  for (const p of remaining) {
    const base = ladders.get(p)![ladders.get(p)!.length - 1];
    let n = 2;
    let name = `${base} ${n}`;
    while (taken.has(name.toLowerCase())) name = `${base} ${++n}`;
    assigned.set(p, name);
    taken.set(name.toLowerCase(), p);
  }

  return assigned;
}

/**
 * A task's spoken form. Tasks are qualified by their plan when spoken aloud
 * ("step three on the context diet plan"), so this only has to be short and
 * unambiguous WITHIN the plan — no cross-item collision pass needed.
 */
export function taskSpoken(text: string): string {
  const clean = stripMarkdown(text).replace(/[.,;:]+$/, '');
  // Tasks are written "**Step 1: Confirm the source** — verify `x` exists…".
  // The em-dash tail is the how; the head is the what. Keep the head — but not
  // at a colon, which would leave a bare "Step 1".
  const head = clean.split(/\s+[—–]\s+/)[0].trim();
  return capWords(head || clean, 72);
}
