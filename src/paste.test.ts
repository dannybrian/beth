// Handing her a log, verbatim — the two ways that fails without saying so.
//
// A fence that its own contents can break spills the log into prose, where a
// line of build output reads as something Danny asked for rather than something
// a compiler said. And output that stops mid-sentence gets answered anyway, with
// the same confidence as output that did not — which is why nothing here
// truncates and the size goes on the button instead.
import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — browser module, plain JS on purpose
import { fence, fenced, inlineCode, testFailureText, commandOutputText, sizeLabel } from '../ui/paste.js';

test('a fence outruns the backticks inside it', () => {
  assert.equal(fence('plain output'), '```');
  assert.equal(fence('a `code` span'), '```');
  // The trap: test output quotes fenced code, and three around three ends early.
  assert.equal(fence('```js\nx\n```'), '````');
  assert.equal(fence('````\nnested\n````'), '`````');
});

test('fenced content cannot terminate its own block', () => {
  const log = 'expected:\n```\nfoo\n```\nbut got nothing';
  const out = fenced(log);
  const f = out.slice(0, out.indexOf('\n'));
  assert.ok(f.length > 3, 'fence grew past the content');
  // Exactly two occurrences of the delimiter — the open and the close.
  assert.equal(out.split(f).length - 1, 2);
  assert.ok(out.includes(log), 'the log survives verbatim');
});

test('a command with a backtick in it does not end its own code span', () => {
  // Caught by running it: a `-e` script quoting a symbol name broke the span and
  // the rest of the command became prose on the headline.
  assert.equal(inlineCode('pnpm test'), '`pnpm test`');
  assert.equal(inlineCode('node -e "x `main` y"'), '``node -e "x `main` y"``');
  // Touching a backtick at either end needs the CommonMark space padding.
  assert.equal(inlineCode('`leading'), '`` `leading ``');
  assert.equal(inlineCode('trailing`'), '`` trailing` ``');
  const head = commandOutputText({
    kind: 'Build',
    command: ['node', '-e', "console.error('missing `main`')"],
    result: { at: 0, ms: 100, exitCode: 2, timedOut: false, output: 'boom' },
  }).split('\n')[0];
  assert.ok(head.startsWith('Build output — ``node -e console.error('), head);
  assert.ok(head.endsWith('`` — exit 2, 0.1s'), head);
});

test('a failure carries its location on the headline, detail fenced below', () => {
  const f = { spoken: 'the settle window', path: 'src/listen.test.ts', line: 42, detail: 'expected 2500' };
  assert.equal(testFailureText(f), 'Failing test: the settle window — src/listen.test.ts:42\n\n```\nexpected 2500\n```');
  // A parser that recovered only a name still produces something sayable.
  assert.equal(testFailureText({ spoken: 'a nameless one' }), 'Failing test: a nameless one');
  assert.equal(
    testFailureText({ spoken: 'no line', path: 'a.ts' }),
    'Failing test: no line — a.ts'
  );
});

test('a run is headed by how it ended — the fact the log usually omits', () => {
  const result = { at: 0, ms: 3200, exitCode: 1, timedOut: false, output: 'boom' };
  const text = commandOutputText({ kind: 'Test', command: ['pnpm', 'test'], result });
  assert.ok(text.startsWith('Test output — `pnpm test` — exit 1, 3.2s'), text);
  assert.ok(text.includes('```\nboom\n```'));
  assert.ok(
    commandOutputText({ kind: 'Build', command: ['x'], result: { ...result, timedOut: true } }).includes('timed out')
  );
  assert.ok(
    commandOutputText({ kind: 'Build', command: ['x'], result: { ...result, cancelled: true } }).includes('stopped')
  );
});

test('the whole tail is pasted — never a second truncation', () => {
  // runCommand already caps at 256 KB, tail-first. Nothing here may cut it
  // again: she answers a half log exactly as confidently as a whole one.
  const big = 'x'.repeat(200_000);
  const text = commandOutputText({
    kind: 'Test',
    command: ['pnpm', 'test'],
    result: { at: 0, ms: 1000, exitCode: 1, timedOut: false, output: big },
  });
  assert.ok(text.includes(big), 'every byte the harness kept is in the paste');
});

test('the button can say what it is about to spend', () => {
  assert.equal(sizeLabel('abcd'), '4 B');
  assert.equal(sizeLabel('x'.repeat(2048)), '2.0 KB');
  assert.equal(sizeLabel('x'.repeat(200_000)), '195 KB');
  // Multi-byte counts as the bytes it will actually cost.
  assert.equal(sizeLabel('é'), '2 B');
});
