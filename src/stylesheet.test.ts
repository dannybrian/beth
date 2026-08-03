import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ⚠️ CSS fails SILENTLY. A stray `*/` in the middle of a comment block ends it
// early, the following lines become garbage, and the browser drops rules until it
// can resync — no error in the console, nothing in the network tab, just layout
// that is subtly wrong for reasons nothing reports. That happened twice in one
// sitting while editing the long explanatory comments this stylesheet is full of,
// and the second time it silently disabled the rule being measured.
//
// This is not a CSS parser. It checks the two things an editing mistake actually
// breaks, and both are cheap.
const css = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'app.css'),
  'utf8'
);

test('every comment opens and closes exactly once', () => {
  let i = 0;
  let line = 1;
  const stray: number[] = [];
  while (i < css.length) {
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      assert.ok(end > 0, `unterminated comment opened at line ${line}`);
      line += css.slice(i, end).split('\n').length - 1;
      i = end + 2;
      continue;
    }
    if (css.startsWith('*/', i)) {
      stray.push(line);
      i += 2;
      continue;
    }
    if (css[i] === '\n') line++;
    i++;
  }
  assert.deepEqual(stray, [], `stray */ — everything after it is parsed as garbage`);
});

test('braces balance', () => {
  const open = (css.match(/{/g) ?? []).length;
  const close = (css.match(/}/g) ?? []).length;
  assert.equal(open, close, `${open} { against ${close} }`);
});
