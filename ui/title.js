// The tab title, computed.
//
// Pure because the failure is INVISIBLE in both directions, which is the same
// trade wire.js makes. A summons that never appears is the silent hang it exists
// to end; one that sticks after you answered is a tab nagging about nothing, and
// you learn to stop reading it. Neither throws, and neither looks wrong on the
// page that caused it — the tab is the one surface you are not looking at.
//
// A tab title cannot be COLOURED — it is plain text in the browser's own chrome
// — so a coloured emoji is the only coloured thing it can carry.

/** Grey is NOTHING rather than ⚪: a repo with no runner, or one where the watch
 * is off, has nothing to say, and a permanent grey circle in every tab would
 * train the eye to stop reading the ones that do. */
export const TITLE_LIGHT = { green: ' 🟢', yellow: ' 🟡', red: ' 🔴' };

/**
 * @param {object} s
 * @param {string} s.base        what the tab is called with no status on it
 * @param {boolean} s.blocked    a card in the transcript has STOPPED her
 * @param {number} s.decisions   queued, non-blocking, get to them whenever
 * @param {boolean} s.error      the server's own view
 * @param {boolean} s.running    a turn in flight, or workers out
 * @param {string=} s.testLight  green | yellow | red
 */
export function tabTitle({ base, blocked, decisions, error, running, testLight }) {
  const badge =
    // Most-blocking first: truncation eats the back, and being stopped outranks
    // a queue that was designed to be ignorable.
    (blocked ? '❗ ' : '') +
    (decisions ? `(${decisions}) ` : '') +
    // ● is suppressed while blocked: she is not thinking, she is waiting on you,
    // and two glyphs for one state is noise in the few characters a tab gets. An
    // error still shows — that is a different thing going wrong.
    (error ? '⚠ ' : !blocked && running ? '● ' : '');
  // What is waiting on YOU goes in front; the tree's state goes after the name.
  // One is a summons, the other is a status.
  return badge + base + (TITLE_LIGHT[testLight] ?? '');
}
