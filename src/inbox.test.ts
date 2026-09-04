import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InboxAcks, addressedTo, createInboxReader, inboxTitle, parseInbox } from './inbox.ts';
import { WorkIndex } from './workIndex.ts';

const rec = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ id: 'm1', at: '2026-09-04T10:00:00Z', text: 'Fix the settle window', from: 'memobase', ...over });

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `harness-${name}-`));

// --- parsing -----------------------------------------------------------------

test('a malformed line among good ones is skipped and counted, never fatal', () => {
  const text = [rec(), '{not json', rec({ id: 'm2' }), JSON.stringify({ id: 'm3', at: 'x' }), ''].join('\n');
  const { records, malformed } = parseInbox(text);
  assert.deepEqual(
    records.map((r) => r.id),
    ['m1', 'm2']
  );
  assert.equal(malformed, 2, 'the broken JSON and the record missing text/from');
});

/**
 * A file that does not end in a newline has a writer mid-append. Treating that
 * line as malformed would count a producer bug that is not one, and treating
 * it as a record would read half a hand-off.
 */
test('a partial last line is a writer mid-append — skipped this pass, not counted', () => {
  const half = rec({ id: 'm2' }).slice(0, 20);
  const { records, malformed, partial } = parseInbox(`${rec()}\n${half}`);
  assert.deepEqual(
    records.map((r) => r.id),
    ['m1']
  );
  assert.equal(malformed, 0);
  assert.equal(partial, true);
});

test('a duplicate id keeps the FIRST record and counts the second', () => {
  const { records, malformed } = parseInbox(`${rec({ text: 'first' })}\n${rec({ text: 'second' })}\n`);
  assert.equal(records.length, 1);
  assert.equal(records[0].text, 'first');
  assert.equal(malformed, 1);
});

test('unknown fields ride along ignored — a producer superset needs no negotiation', () => {
  const { records } = parseInbox(`${rec({ confidence: 0.9, category: 'todo', to: 'Beth' })}\n`);
  assert.equal(records[0].to, 'Beth');
  assert.equal((records[0] as Record<string, unknown>).confidence, undefined);
});

test('the title is the producer\'s, else the first line of the text without its markers', () => {
  assert.equal(inboxTitle({ title: 'Given', text: '- other' }), 'Given');
  assert.equal(inboxTitle({ text: '\n- [ ] **Fix** the `settle` window\nmore' }), 'Fix the settle window');
  const long = inboxTitle({ text: 'x'.repeat(120) });
  assert.ok(long.length <= 90 && long.endsWith('…'), long);
});

// --- addressing --------------------------------------------------------------

test('addressing: unaddressed is for everyone, a name matches case-insensitively, a stranger is hidden', () => {
  assert.equal(addressedTo({}, 'Beth'), true);
  assert.equal(addressedTo({ to: 'beth' }, 'Beth'), true);
  assert.equal(addressedTo({ to: 'Wren' }, 'Beth'), false);
  // A director with no name cannot be addressed — only the unaddressed reach her.
  assert.equal(addressedTo({ to: 'Beth' }, ''), false);
});

// --- the reader ---------------------------------------------------------------

function inbox() {
  const dir = tmp('inbox');
  const state = tmp('inbox-state');
  const drop = path.join(dir, 'drop');
  fs.mkdirSync(drop);
  fs.writeFileSync(path.join(drop, 'notes.jsonl'), `${rec({ id: 'n1', text: 'Unaddressed one' })}\n`);
  const outbox = path.join(dir, 'elsewhere', 'memobase.jsonl');
  fs.mkdirSync(path.dirname(outbox));
  fs.writeFileSync(
    outbox,
    [rec({ id: 'm1', to: 'Beth', title: 'For Beth', ref: 'memos/2026/a.md' }), rec({ id: 'm2', to: 'Wren', title: 'For Wren' }), ''].join('\n')
  );
  return { dir, drop, outbox, state };
}

const indexOver = (reader: ReturnType<typeof createInboxReader>) => {
  const idx = new WorkIndex([reader]);
  idx.refresh();
  return idx;
};

test('the drop directory and a named file are both read, and only what is addressed here shows', () => {
  const { drop, outbox, state } = inbox();
  const acks = new InboxAcks({ stateDir: state });
  const idx = indexOver(createInboxReader({ dir: drop, files: [outbox], director: () => 'beth', acks }));
  assert.deepEqual(
    idx.all().map((i) => [i.path, i.title, i.status]),
    [
      ['inbox/memobase/m1', 'For Beth', 'inbox'],
      ['inbox/notes/n1', 'Unaddressed one', 'inbox'],
    ]
  );
  // The content rides the item — there is no file behind it for anyone to read.
  const m1 = idx.byPath('inbox/memobase/m1')!;
  assert.equal(m1.inbox?.from, 'memobase');
  assert.equal(m1.inbox?.ref, 'memos/2026/a.md');
  assert.equal(m1.reader, 'inbox');
  // The watcher covers both places.
  const roots = idx['readers'][0].watchRoots();
  assert.ok(roots.includes(drop) && roots.includes(path.dirname(outbox)));
});

test('the director\'s name is read at read time — a persona switch re-addresses the inbox', () => {
  const { drop, outbox, state } = inbox();
  let me = 'Beth';
  const idx = indexOver(
    createInboxReader({ dir: drop, files: [outbox], director: () => me, acks: new InboxAcks({ stateDir: state }) })
  );
  assert.ok(idx.byPath('inbox/memobase/m1'));
  me = 'Wren';
  idx.refresh();
  assert.equal(idx.byPath('inbox/memobase/m1'), undefined);
  assert.ok(idx.byPath('inbox/memobase/m2'));
  assert.ok(idx.byPath('inbox/notes/n1'), 'unaddressed shows to either');
});

test('a missing drop directory and a missing named file are an empty inbox, not an error', () => {
  const idx = indexOver(
    createInboxReader({
      dir: path.join(tmp('inbox'), 'nope'),
      files: ['/nonexistent/outbox.jsonl'],
      director: () => 'Beth',
      acks: new InboxAcks({ stateDir: tmp('s') }),
    })
  );
  assert.deepEqual(idx.all(), []);
});

// --- acks ---------------------------------------------------------------------

test('an ack moves the item out of the live set, survives a restart, and reopens on null', () => {
  const { drop, outbox, state } = inbox();
  const reader = (acks: InboxAcks) => createInboxReader({ dir: drop, files: [outbox], director: () => 'Beth', acks });
  const acks = new InboxAcks({ stateDir: state });
  acks.set('inbox/memobase/m1', { state: 'done', ref: 'plans/2026-09-04-01-settle.md' });
  acks.set('inbox/notes/n1', { state: 'dismissed' });
  let idx = indexOver(reader(acks));
  assert.equal(idx.byPath('inbox/memobase/m1')!.status, 'shipped');
  assert.equal(idx.byPath('inbox/memobase/m1')!.inbox?.ack?.ref, 'plans/2026-09-04-01-settle.md');
  assert.equal(idx.byPath('inbox/notes/n1')!.status, 'parked');
  assert.deepEqual(idx.live(), []);

  // A second store over the same state dir is what a restart looks like.
  const again = new InboxAcks({ stateDir: state });
  idx = indexOver(reader(again));
  assert.equal(idx.byPath('inbox/memobase/m1')!.status, 'shipped');

  again.set('inbox/memobase/m1', null);
  idx.refresh();
  assert.equal(idx.byPath('inbox/memobase/m1')!.status, 'inbox');
});

/**
 * The rule everything else stands on: the producer's file is never written.
 * Hashed before and after a read and an ack, because "never" is the kind of
 * claim that quietly stops being true.
 */
test('nothing here touches the producer\'s file — read, ack, re-read', () => {
  const { drop, outbox, state } = inbox();
  const before = [fs.readFileSync(outbox), fs.readFileSync(path.join(drop, 'notes.jsonl'))];
  const acks = new InboxAcks({ stateDir: state });
  const idx = indexOver(createInboxReader({ dir: drop, files: [outbox], director: () => 'Beth', acks }));
  acks.set('inbox/memobase/m1', { state: 'done' });
  idx.refresh();
  assert.deepEqual([fs.readFileSync(outbox), fs.readFileSync(path.join(drop, 'notes.jsonl'))], before);
  assert.deepEqual(fs.readdirSync(drop), ['notes.jsonl'], 'and nothing was added beside it');
});

test('a corrupt ack file is an empty store, and a bad entry in a good one is dropped', () => {
  const state = tmp('acks');
  fs.writeFileSync(path.join(state, 'inbox.json'), '{oops');
  assert.equal(new InboxAcks({ stateDir: state }).get('x'), undefined);
  fs.writeFileSync(
    path.join(state, 'inbox.json'),
    JSON.stringify({ good: { state: 'done', at: '2026-09-04T10:00:00Z' }, bad: { state: 'taken' } })
  );
  const acks = new InboxAcks({ stateDir: state });
  assert.equal(acks.get('good')?.state, 'done');
  assert.equal(acks.get('bad'), undefined);
});
