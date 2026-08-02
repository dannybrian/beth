import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectRunner, parseFailures } from './testRunner.ts';

/** A throwaway repo containing exactly the files a detector should key on. */
function repoWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tests-'));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

// --- detection ---------------------------------------------------------------

test('the package manager comes from what the project DECLARES', () => {
  // packageManager is what corepack reads, so it is the least ambiguous signal —
  // and it must beat a stale lockfile from a previous manager.
  const repo = repoWith({
    'package.json': JSON.stringify({ scripts: { test: 'node --test' }, packageManager: 'pnpm@10.29.2' }),
    'yarn.lock': '',
  });
  assert.deepEqual(detectRunner(repo)?.command, ['pnpm', 'test']);
});

test('...and falls back to the lockfile, then to npm', () => {
  const withPnpm = repoWith({ 'package.json': '{"scripts":{"test":"x"}}', 'pnpm-lock.yaml': '' });
  assert.deepEqual(detectRunner(withPnpm)?.command, ['pnpm', 'test']);
  const withYarn = repoWith({ 'package.json': '{"scripts":{"test":"x"}}', 'yarn.lock': '' });
  assert.deepEqual(detectRunner(withYarn)?.command, ['yarn', 'test']);
  const bare = repoWith({ 'package.json': '{"scripts":{"test":"x"}}' });
  assert.deepEqual(detectRunner(bare)?.command, ['npm', 'test']);
});

test('a package.json with NO test script is not a runner', () => {
  // Running `npm test` there prints an error and exits non-zero, which would
  // show a red light for a repo that simply has no tests.
  const repo = repoWith({ 'package.json': '{"name":"x"}', 'Makefile': 'test:\n\techo hi\n' });
  assert.deepEqual(detectRunner(repo)?.command, ['make', 'test']);
});

test('an unparseable package.json does not throw, it just is not a runner', () => {
  const repo = repoWith({ 'package.json': '{ not json' });
  assert.equal(detectRunner(repo), null);
});

test('the other ecosystems, each by the file that names them', () => {
  assert.deepEqual(detectRunner(repoWith({ 'App.csproj': '' }))?.command, ['dotnet', 'test']);
  assert.deepEqual(detectRunner(repoWith({ 'Cargo.toml': '' }))?.command, ['cargo', 'test']);
  assert.deepEqual(detectRunner(repoWith({ 'go.mod': '' }))?.command, ['go', 'test', './...']);
  assert.deepEqual(detectRunner(repoWith({ 'pyproject.toml': '' }))?.command, ['pytest']);
});

test('a Makefile without a test target is not a runner', () => {
  assert.equal(detectRunner(repoWith({ Makefile: 'build:\n\tcc x.c\n' })), null);
});

test('a repo the detectors do not recognise gets NOTHING, never a guess', () => {
  // A guessed command is a shell execution nobody authorised.
  assert.equal(detectRunner(repoWith({ 'README.md': '# hi' })), null);
});

test('HARNESS_TEST_CMD beats every detector, and never reaches a shell', () => {
  const repo = repoWith({ 'package.json': '{"scripts":{"test":"x"}}' });
  const got = detectRunner(repo, 'bin/ci --suite unit');
  assert.deepEqual(got?.command, ['bin/ci', '--suite', 'unit']);
  assert.equal(got?.why, 'HARNESS_TEST_CMD');
});

// --- parsing -----------------------------------------------------------------

const REPO = '/Users/dbrian/Sources/thing';

test('node --test, spec reporter: name, file and line', () => {
  const out = `
✔ a passing one (1.2ms)
✖ the settle window holds a finished sentence (3.4ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  2500 !== 1200
      at TestContext.<anonymous> (file:///Users/dbrian/Sources/thing/src/listen.test.ts:71:12)
ℹ tests 2
ℹ fail 1
`;
  const f = parseFailures(out, REPO);
  assert.equal(f.length, 1);
  assert.equal(f[0].spoken, 'the settle window holds a finished sentence');
  assert.equal(f[0].path, 'src/listen.test.ts');
  assert.equal(f[0].line, 71);
  assert.match(f[0].detail ?? '', /AssertionError/);
});

test('REAL node output names each failure twice — report it once, richest', () => {
  // Verbatim from a run, because the fixture I invented did not have this shape
  // and the invented one passed while the real one produced three entries for
  // one failure: the bare result line, the "failing tests:" header, and the
  // repeat that actually carries the error.
  const out = `
✖ the settle window holds a finished sentence (2.045334ms)
✔ a passing one (0.147ms)
ℹ tests 2
ℹ fail 1

✖ failing tests:

test at a.test.js:3:1
✖ the settle window holds a finished sentence (2.045334ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  2500 !== 1200

      at TestContext.<anonymous> (file:///Users/dbrian/Sources/thing/a.test.js:3:66)
`;
  const f = parseFailures(out, REPO);
  assert.equal(f.length, 1);
  assert.equal(f[0].spoken, 'the settle window holds a finished sentence');
  assert.equal(f[0].path, 'a.test.js');
  assert.equal(f[0].line, 3);
  assert.match(f[0].detail ?? '', /^AssertionError/);
});

test('a failure never inherits the NEXT test as its detail', () => {
  // The window has to stop at the following marker, or a failure with no error
  // block of its own quietly reports the line after it.
  const f = parseFailures('✖ broke (1ms)\n✔ fine (1ms)\n', REPO);
  assert.equal(f.length, 1);
  assert.equal(f[0].detail, undefined);
});

test('a repo reached through a symlink still gets relative paths', () => {
  // /tmp is /private/tmp on macOS, and every git worktree has the same shape:
  // the repo reports one root and the output prints the other. Without realpath
  // every location stays absolute, which is how this was found.
  const dir = repoWith({ 'a.test.js': '' });
  const real = fs.realpathSync(dir);
  const f = parseFailures(`✖ x (1ms)\n      at f (${real}/a.test.js:3:1)\n`, dir);
  assert.equal(f[0].path, 'a.test.js');
});

test('the run SUMMARY is not a failing test', () => {
  // `✖ fail 1` is the rollup. Counting it would invent a failure named "fail 1".
  const f = parseFailures('✔ ok (1ms)\n✖ fail 1\nℹ pass 1\n', REPO);
  assert.equal(f.length, 0);
});

test('node --test, TAP: what it emits when not writing to a terminal', () => {
  const out = `
not ok 1 - a thing that broke
  ---
  duration_ms: 2.5
  location: '/Users/dbrian/Sources/thing/src/x.test.ts:12:3'
  failureType: 'testCodeFailure'
  error: 'Expected 1 to equal 2'
  ---
`;
  const f = parseFailures(out, REPO);
  assert.equal(f.length, 1);
  assert.equal(f[0].spoken, 'a thing that broke');
  assert.equal(f[0].path, 'src/x.test.ts');
  assert.equal(f[0].line, 12);
});

test('pytest: the summary line carries all three facts', () => {
  const f = parseFailures('FAILED tests/test_geo.py::test_pin_placement - AssertionError: off by one\n', REPO);
  assert.equal(f.length, 1);
  assert.equal(f[0].spoken, 'test pin placement');
  assert.equal(f[0].path, 'tests/test_geo.py');
  assert.equal(f[0].detail, 'AssertionError: off by one');
});

test('go test', () => {
  const f = parseFailures('--- FAIL: TestPinPlacement (0.00s)\n    geo_test.go:42: got 3 want 4\nFAIL\n', REPO);
  assert.equal(f.length, 1);
  assert.equal(f[0].spoken, 'TestPinPlacement');
  assert.equal(f[0].path, 'geo_test.go');
  assert.equal(f[0].line, 42);
});

test('cargo test', () => {
  const out = `
---- geo::tests::pin_placement stdout ----
thread 'geo::tests::pin_placement' panicked at src/geo.rs:88:9:
assertion failed
`;
  const f = parseFailures(out, REPO);
  assert.equal(f.length, 1);
  assert.equal(f[0].spoken, 'pin placement');
  assert.equal(f[0].path, 'src/geo.rs');
  assert.equal(f[0].line, 88);
});

test('dotnet test', () => {
  const out = `
  Failed Tulito.Tests.GeoTests.PinPlacement [12 ms]
  Error Message:
   Assert.Equal() Failure
  Stack Trace:
     at Tulito.Tests.GeoTests.PinPlacement() in /Users/dbrian/Sources/thing/Tests/GeoTests.cs:line 42
`;
  const f = parseFailures(out, REPO);
  assert.equal(f.length, 1);
  assert.equal(f[0].spoken, 'PinPlacement');
  assert.equal(f[0].path, 'Tests/GeoTests.cs');
  assert.equal(f[0].line, 42);
});

test('an absolute path inside the repo is said the way he thinks of it', () => {
  const f = parseFailures(`✖ x (1ms)\n      at f (${REPO}/src/deep/thing.test.ts:9:1)\n`, REPO);
  assert.equal(f[0].path, 'src/deep/thing.test.ts');
});

test('a path OUTSIDE the repo keeps its shape rather than being mangled', () => {
  const f = parseFailures('✖ x (1ms)\n      at f (/opt/homebrew/lib/node/thing.js:9:1)\n', REPO);
  assert.equal(f[0].path, '/opt/homebrew/lib/node/thing.js');
});

test('unrecognisable output yields no failures rather than nonsense', () => {
  // The raw log is still shown — better nothing than an invented test name.
  assert.deepEqual(parseFailures('Build failed: linker error\nexit 1\n', REPO), []);
});

test('a failure with no location still counts — a name alone is usable', () => {
  const f = parseFailures('✖ something went wrong (1ms)\n  Error: boom\n', REPO);
  assert.equal(f.length, 1);
  assert.equal(f[0].spoken, 'something went wrong');
  assert.equal(f[0].path, undefined);
});

test('the RICHEST parser wins, so a wrapper command cannot mislead us', () => {
  // A project's `test` script is often a wrapper that runs something else, which
  // is why the format is never guessed from the command.
  const out = 'FAILED tests/a.py::test_one - boom\nFAILED tests/b.py::test_two - bang\n✖ noise\n';
  const f = parseFailures(out, REPO);
  assert.equal(f.length, 2);
  assert.deepEqual(f.map((x) => x.path), ['tests/a.py', 'tests/b.py']);
});
