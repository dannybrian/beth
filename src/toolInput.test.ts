import test from 'node:test';
import assert from 'node:assert/strict';
import { repairArgs } from './toolInput.ts';

// ⚠️ REAL, not invented. Lifted verbatim from the tool_use block in
// ~/.claude/projects/-Users-dbrian-Sources-beadgame/a2b9b7f1-….jsonl, the call
// that put "</context><parameter name=…" in Danny's pending queue on 2026-08-02.
// A fixture written from memory of this shape would have had the closing
// `</parameter>` that the real one does not, and the parser would have been
// written to need it.
const REAL = {
  title: 'Eight deployed services have non-reproducible Docker builds — open a follow-up plan?',
  context:
    "The Phase 3 worker audited the other ten Dockerfiles. None has colyseus-server's specific defect, because none of them is reproducible at all: auth and lexicon-optimizer track a package-lock the Dockerfile never copies. Not urgent — nothing is broken today — but it's the same class of latent break that the dotenv grenade turned out to be.</context>\n<parameter name=\"options\">[\"Open a follow-up plan now\", \"Park it in plans/future\", \"Fold into the existing dependency-hygiene-and-CI plan\", \"Leave it — record only\"]",
  urgency: 'when-free',
  plan: 'plans/2026-08-01-container-runtime-and-dependency-hygiene.md',
} as Record<string, any>;

test('the real malformed call gives back its context AND its options', () => {
  const { args, repaired } = repairArgs(REAL);
  assert.ok(args.context.endsWith('the dotenv grenade turned out to be.'), args.context.slice(-60));
  assert.ok(!/<\/context>|<parameter/.test(args.context), 'no markup left in what he reads');
  assert.deepEqual(args.options, [
    'Open a follow-up plan now',
    'Park it in plans/future',
    'Fold into the existing dependency-hygiene-and-CI plan',
    'Leave it — record only',
  ]);
  assert.deepEqual(repaired, ['context', 'options'], 'and it says what it touched');
});

test('everything that arrived properly is left alone', () => {
  const { args } = repairArgs(REAL);
  assert.equal(args.urgency, 'when-free');
  assert.equal(args.plan, 'plans/2026-08-01-container-runtime-and-dependency-hygiene.md');
  assert.equal(args.title, REAL.title);
});

test('an ordinary call is returned untouched, and says so', () => {
  const clean = { title: 'Ship it?', context: 'Everything passes.', options: ['yes', 'no'] };
  const { args, repaired } = repairArgs(clean);
  assert.deepEqual(args, clean);
  assert.deepEqual(repaired, []);
});

// She writes about markup — the director of a repo with an XML-ish tool format
// will eventually put a closing tag in a sentence, and that is not a broken call.
test('a message that merely MENTIONS the tag is not mangled', () => {
  const args = {
    text: 'The model emits </context> in the middle of the call, which is the bug.',
    kind: 'finding',
  };
  assert.deepEqual(repairArgs(args).args, args);
});

test('a recovered parameter never beats one that arrived properly', () => {
  const { args } = repairArgs({
    context: 'Body.</context>\n<parameter name="options">["recovered"]',
    options: ['the real one'],
  });
  assert.deepEqual(args.options, ['the real one']);
  assert.equal(args.context, 'Body.');
});

test('several swallowed parameters all come back, JSON or plain', () => {
  const { args } = repairArgs({
    context: 'Body.</context>\n<parameter name="options">["a","b"]\n<parameter name="urgency">today',
  });
  assert.deepEqual(args.options, ['a', 'b']);
  assert.equal(args.urgency, 'today');
});

test('a closing </parameter> is tolerated when it IS there', () => {
  // The two real calls did not close the block. A model that does must not end up
  // with the tag inside the value.
  const { args } = repairArgs({
    context: 'Body.</context><parameter name="urgency">today</parameter>',
  });
  assert.equal(args.urgency, 'today');
});

test('a truncated tail costs the tail, not the field', () => {
  const { args } = repairArgs({ context: 'Body.</context>\n<parameter name="options">["a", "b"' });
  assert.equal(args.context, 'Body.', 'what he reads is clean either way');
  assert.equal(args.options, '["a", "b"', 'unparseable JSON survives as text rather than vanishing');
});
