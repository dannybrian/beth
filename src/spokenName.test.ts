import test from 'node:test';
import assert from 'node:assert/strict';
import { assignSpokenNames, capWords, headline, slugName, taskSpoken } from './spokenName.ts';

test('headline keeps the name and drops the elaboration', () => {
  assert.equal(headline('Director consolidation — the archived-tabs handoff'), 'Director consolidation');
  assert.equal(headline('Viz sidecar: `scores.regionality` + resolved `geo.pins` — delivery'), 'Viz sidecar');
  assert.equal(headline('Surface Wear Library, Decal-Receiver Proving & Shader Optimization'), 'Surface Wear Library');
  assert.equal(headline('The Venue layer (concept umbrella)'), 'The Venue layer');
});

test('headline does not split names joined by + or &', () => {
  // These read as one name aloud; cutting them loses the plan.
  assert.equal(headline('Menu Fluidity + Screen Revival'), 'Menu Fluidity + Screen Revival');
  assert.equal(headline('Era-Band Prominence & Common Hatch'), 'Era-Band Prominence & Common Hatch');
});

test('slugName drops the date prefix and any issue number', () => {
  assert.equal(slugName('game/plans/unity/2026-07-30-174-menu-fluidity-and-screen-revival.md'), 'menu fluidity and screen revival');
  assert.equal(slugName('plans/future/2026-08-01-director-context-diet.md'), 'director context diet');
});

test('a truncated name never ends on a dangling function word', () => {
  // Real case from the corpus: cutting at a clean word boundary still produced
  // "…still holds the", which sounds like Beth got cut off mid-sentence.
  const out = capWords('Old captures: game/backend/server/.device-logs/ still holds the previous run', 62);
  assert.ok(!/\b(the|a|an|of|to|and|in|for|with|on|at)$/i.test(out), `ended on a function word: "${out}"`);
  assert.ok(out.endsWith('holds'));
});

test('capWords trims at a word boundary, never mid-word', () => {
  const long = 'Surface Wear Library Decal Receiver Proving and Shader Optimization Pass';
  const out = capWords(long, 40);
  assert.ok(out.length <= 40);
  assert.ok(!long.slice(out.length).startsWith('x'), 'no mid-word cut');
  assert.ok(long.startsWith(out));
});

test('a unique title keeps its good prose name', () => {
  const names = assignSpokenNames([
    { path: 'plans/2026-07-30-director-consolidation.md', title: 'Director consolidation — the archived-tabs handoff' },
  ]);
  assert.equal(names.get('plans/2026-07-30-director-consolidation.md'), 'Director consolidation');
});

test('colliding headlines fall back to the filename, which is distinct', () => {
  // The real case: three in-flight beadgame plans all headline to "Viz sidecar".
  const items = [
    { path: 'plans/2026-07-15-viz-geography-delivery.md', title: 'Viz sidecar: `geo.pins` — delivery' },
    { path: 'plans/2026-07-09-viz-time-dates-delivery.md', title: 'Viz sidecar: `dates` — delivery' },
    { path: 'plans/2026-07-09-viz-hier-delivery.md', title: 'Viz sidecar: `hier` — delivery' },
  ];
  const names = assignSpokenNames(items);
  const spoken = items.map((i) => names.get(i.path)!);
  assert.equal(new Set(spoken).size, 3, 'all three resolve distinctly');
  assert.ok(spoken.includes('viz geography delivery'));
  assert.ok(spoken.includes('viz time dates delivery'));
  assert.ok(spoken.includes('viz hier delivery'));
  // And none of them silently kept the ambiguous name.
  assert.ok(!spoken.includes('Viz sidecar'));
});

test('a collision does not cost the non-colliding item its good name', () => {
  const items = [
    { path: 'a/2026-01-01-design-of-the-thing.md', title: 'Design — of the thing' },
    { path: 'b/2026-01-02-design-of-another.md', title: 'Design — of another' },
    { path: 'c/2026-01-03-unity-mcp-bridge.md', title: 'Unity MCP Editor Bridge — adopted' },
  ];
  const names = assignSpokenNames(items);
  assert.equal(names.get('c/2026-01-03-unity-mcp-bridge.md'), 'Unity MCP Editor Bridge');
  assert.equal(new Set([...names.values()]).size, 3);
});

test('assignment is stable regardless of input order', () => {
  const items = [
    { path: 'plans/2026-07-15-viz-geography-delivery.md', title: 'Viz sidecar — delivery' },
    { path: 'plans/2026-07-09-viz-time-dates-delivery.md', title: 'Viz sidecar — delivery' },
    { path: 'plans/2026-07-01-book-content-api.md', title: 'Book content API' },
  ];
  const forward = assignSpokenNames(items);
  const backward = assignSpokenNames([...items].reverse());
  for (const i of items) assert.equal(forward.get(i.path), backward.get(i.path), i.path);
});

test('identical title AND identical filename still never share a spoken name', () => {
  // Exhausts the ladder — the counter fallback is the last line of defence,
  // because a duplicate spoken name resolves a reference to the wrong plan.
  const items = [
    { path: 'x/plans/2026-01-01-same.md', title: 'Same' },
    { path: 'y/plans/2026-01-01-same.md', title: 'Same' },
  ];
  const names = assignSpokenNames(items);
  assert.equal(new Set([...names.values()]).size, 2);
});

test('every item gets a non-empty name', () => {
  const items = [
    { path: 'plans/2026-01-01-.md', title: '' },
    { path: 'plans/2026-01-02-x.md', title: '—' },
  ];
  const names = assignSpokenNames(items);
  for (const i of items) assert.ok((names.get(i.path) ?? '').length > 0, i.path);
});

test('an explicit name wins over derivation, verbatim and uncapped', () => {
  const items = [
    {
      path: 'plans/2026-08-01-director-context-diet.md',
      title: 'Director context diet — trimming the standing prefix',
      name: 'the context diet plan',
    },
  ];
  const names = assignSpokenNames(items);
  assert.equal(names.get(items[0].path), 'the context diet plan');
});

test('naming one plan cannot be stolen by another plan title', () => {
  // The named plan must keep its name even though the other plan's headline
  // derives to exactly the same string.
  const items = [
    { path: 'a/2026-01-02-zzz.md', title: 'Context diet' },
    { path: 'b/2026-01-01-aaa.md', title: 'Something else entirely', name: 'Context diet' },
  ];
  const names = assignSpokenNames(items);
  assert.equal(names.get('b/2026-01-01-aaa.md'), 'Context diet');
  assert.notEqual(names.get('a/2026-01-02-zzz.md'), 'Context diet');
  assert.equal(new Set([...names.values()]).size, 2);
});

test('two plans claiming the same explicit name do not both get it', () => {
  const items = [
    { path: 'a/2026-01-01-one.md', title: 'One', name: 'the diet' },
    { path: 'b/2026-01-02-two.md', title: 'Two', name: 'the diet' },
  ];
  const names = assignSpokenNames(items);
  assert.equal(new Set([...names.values()]).size, 2, 'the loser falls through to derivation');
});

test('taskSpoken keeps the what and drops the how', () => {
  assert.equal(
    taskSpoken('**Step 1: Confirm the source** — verify `dealerScores.time` exists on published beads'),
    'Step 1: Confirm the source'
  );
  // A colon must NOT be a break here, or every task becomes a bare "Step 4".
  assert.equal(taskSpoken('**Step 4: Run** `node --test` → GREEN.'), 'Step 4: Run node --test → GREEN');
});
