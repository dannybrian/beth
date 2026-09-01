// Handing Beth a test failure or a build log, verbatim.
//
// The panel already POINTS at a failure — a reference pair, a name she can say —
// and that stays the default because a chip is the right size for "what's left
// on this?". This is the other half: sometimes the answer is in the output and
// nothing short of the output will do, and retyping a stack trace at her is not
// a workflow.
//
// Pure, and tested, because both failures here are silent. A fence that does not
// survive its own contents spills the log into prose, where a line of build
// output reads as something Danny asked for rather than something a compiler
// said. And a paste that quietly drops the tail makes her reason confidently
// about output that stops mid-sentence — which looks exactly like a considered
// answer, and is the reason nothing here truncates.

/**
 * A fence longer than any run of backticks inside the text.
 *
 * Test output quotes code, and code has fences in it. Three backticks around a
 * log that contains three backticks ends the block early, and everything after
 * it stops being output and starts being instructions.
 */
const longestRun = (text) => {
  let longest = 0;
  for (const run of String(text).matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return longest;
};

export function fence(text) {
  return '`'.repeat(Math.max(3, longestRun(text) + 1));
}

/**
 * The same rule one level up, for the command on the headline.
 *
 * A command can contain a backtick — shell quoting, a `-e` script — and one
 * inside a single-backtick span ends it early, so the rest of the command
 * becomes prose and the line reads as something Danny wrote. Found by running
 * it, not by reading it.
 */
export function inlineCode(text) {
  const s = String(text);
  const d = '`'.repeat(longestRun(s) + 1);
  // CommonMark: content touching a backtick at either end needs one space of
  // padding, which the renderer strips back off.
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${d}${pad}${s}${pad}${d}`;
}

/** Wrap text in a fence that its own contents cannot break. */
export function fenced(text, info = '') {
  const f = fence(text);
  return `${f}${info}\n${String(text).replace(/\s+$/, '')}\n${f}`;
}

/**
 * One failure, as much as the parser recovered of it.
 *
 * Location on the same line as the name: she is asked to open it as often as to
 * talk about it, and a path on its own line reads as a second fact.
 */
export function testFailureText(f) {
  const where = f.path ? `${f.path}${f.line ? `:${f.line}` : ''}` : '';
  const head = `Failing test: ${f.spoken}${where ? ` — ${where}` : ''}`;
  return f.detail ? `${head}\n\n${fenced(f.detail)}` : head;
}

/**
 * A whole run, headed by how it ended — because "exit 1" is the thing that makes
 * the log worth reading, and it is the one fact the log itself often omits.
 */
export function commandOutputText({ kind, command, result }) {
  const how = result.cancelled
    ? 'stopped'
    : result.timedOut
      ? 'timed out'
      : `exit ${result.exitCode}`;
  const secs = `${(result.ms / 1000).toFixed(1)}s`;
  const head = `${kind} output — ${inlineCode(command.join(' '))} — ${how}, ${secs}`;
  return `${head}\n\n${fenced(result.output)}`;
}

/** Bytes, for a button that must say what it is about to spend. */
export function sizeLabel(text) {
  const n = new TextEncoder().encode(String(text)).length;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
