// The mouth core, tested with a plain callback where the bus used to be —
// these are the SpeakOut tests that were never about the conversation, moved
// onto the library they were always testing. The bus-facing half (the
// subscription, the levels, replay) stays in src/speakOut.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Mouth, type MouthConfig } from './mouth.ts';

const cfg = (over: Partial<MouthConfig> = {}): MouthConfig => ({
  apiKey: 'sk_test',
  voiceId: 'v_test',
  ttsModel: 'eleven_flash_v2_5',
  usdPer1kCredits: 0.22,
  ...over,
});

function mouth(over: Partial<MouthConfig> = {}) {
  const lines: { id: string; chars: number }[] = [];
  const m = new Mouth(cfg(over), (l) => lines.push(l));
  return { m, lines };
}

test('a spoken line surfaces as an id and a length — never the words', () => {
  const { m, lines } = mouth();
  const id = m.speak('Tests are green.');
  assert.ok(id);
  assert.deepEqual(lines, [{ id, chars: 'Tests are green.'.length }]);
  assert.equal(m.textFor(id!), 'Tests are green.');
});

test('audio tags are stripped, because a realtime model reads them aloud', () => {
  const { m } = mouth();
  const id = m.speak('[laughs] Tests are green.');
  assert.equal(m.textFor(id!), 'Tests are green.');
});

test('a line that is nothing BUT a tag never becomes a spoken line', () => {
  // It would otherwise mint an id the owner fetches, pay for a request, and
  // play silence — and the caller would believe it had been said.
  const { m, lines } = mouth();
  assert.equal(m.speak('[sighs]'), null);
  assert.equal(m.speak('   '), null);
  assert.equal(lines.length, 0);
});

test('tags SURVIVE when the model is a v3 one', () => {
  const { m } = mouth({ ttsModel: 'eleven_v3' });
  const id = m.speak('[laughs] Tests are green.');
  assert.equal(m.textFor(id!), '[laughs] Tests are green.');
});

test('unconfigured is silent rather than throwing — voice is optional', () => {
  for (const over of [{ apiKey: undefined }, { voiceId: undefined, speechEngineId: undefined }]) {
    const { m, lines } = mouth(over);
    assert.equal(m.speak('anything'), null);
    // And it says WHY, because a text-only harness that looks healthy is the
    // failure mode this whole plane exists to remove.
    assert.ok(m.unavailableReason);
    assert.equal(lines.length, 0);
  }
});

test('an engine id alone is enough — the voice is inherited from it', () => {
  const { m } = mouth({ voiceId: undefined, speechEngineId: 'seng_x' });
  assert.ok(m.speak('Ready.'));
  assert.equal(m.unavailableReason, null);
});

test('held lines are capped, so an unattended run cannot grow forever', () => {
  const { m } = mouth();
  for (let i = 0; i < 200; i++) m.speak(`line ${i}`);
  assert.ok(m.status().held <= 64, `held ${m.status().held}`);
  // The NEWEST survive: old news is the news worth dropping.
  assert.equal(m.textFor('s200'), 'line 199');
});

test('ids are unique across lines, so two never collide on one fetch', () => {
  const { m } = mouth();
  const ids = new Set([m.speak('one'), m.speak('two'), m.speak('three')]);
  assert.equal(ids.size, 3);
});

test('an id is not consumed by reading it — a reload can ask again', () => {
  const { m } = mouth();
  const id = m.speak('Tests are green.')!;
  assert.equal(m.textFor(id), 'Tests are green.');
  assert.equal(m.textFor(id), 'Tests are green.');
});

// --- the bill ----------------------------------------------------------------
//
// ElevenLabs charges for the REQUEST. Everything here is about counting at that
// moment rather than at the tempting one.

/** Stub the client and skip resolution — no network, no engine lookup. */
function billable(m: Mouth, opts: { fail?: boolean; modelId?: string } = {}) {
  const sent: string[] = [];
  (m as unknown as { resolved: unknown }).resolved = {
    voiceId: 'v_test',
    modelId: opts.modelId ?? 'eleven_flash_v2_5',
  };
  (m as unknown as { client: unknown }).client = {
    textToSpeech: {
      stream: async (_v: string, body: { text: string }) => {
        if (opts.fail) throw new Error('missing_permissions');
        sent.push(body.text);
        return 'audio' as unknown;
      },
    },
  };
  return sent;
}

test('a line that is HELD but never fetched costs nothing', async () => {
  // The tempting place to count is speak(). It would report money for every
  // line queued into a closed tab, and for lines a level dropped out from
  // under before anyone asked.
  const { m } = mouth();
  billable(m);
  m.speak('Tests are green.');
  assert.deepEqual(m.spend().lines, 0);
  assert.deepEqual(m.spend().chars, 0);
});

test('fetching the audio is what bills, and fetching it twice bills twice', async () => {
  const { m } = mouth();
  billable(m);
  const id = m.speak('Tests are green.')!;
  await m.stream(id);
  assert.deepEqual({ lines: m.spend().lines, chars: m.spend().chars }, { lines: 1, chars: 16 });
  // A reload re-requests a held line, and ElevenLabs charges again.
  await m.stream(id);
  assert.deepEqual({ lines: m.spend().lines, chars: m.spend().chars }, { lines: 2, chars: 32 });
});

test('a request that FAILED is not a request that was billed', async () => {
  const { m } = mouth();
  billable(m, { fail: true });
  const id = m.speak('Tests are green.')!;
  await assert.rejects(() => m.stream(id));
  assert.equal(m.spend().chars, 0);
  assert.ok(m.status().error, 'and it says why');
});

test('the realtime models bill at half rate — the estimate follows the MODEL', async () => {
  const { m: flash } = mouth();
  billable(flash);
  await flash.stream(flash.speak('a'.repeat(1000))!);
  assert.equal(flash.spend().credits, 500);
  assert.equal(flash.spend().usd, (500 / 1000) * 0.22);

  const { m: v3 } = mouth({ ttsModel: 'eleven_v3' });
  billable(v3, { modelId: 'eleven_v3' });
  await v3.stream(v3.speak('a'.repeat(1000))!);
  assert.equal(v3.spend().credits, 1000);
});

test('the rate behind the estimate travels with it, so a page can print it', () => {
  // The dollars are the only guessed part — no API hands us the plan's price —
  // so the assumption is shown rather than buried.
  const { m } = mouth({ usdPer1kCredits: 0.165 });
  assert.deepEqual(
    { r: m.spend().usdPer1kCredits, c: m.spend().creditsPerChar, m: m.spend().model },
    { r: 0.165, c: 0.5, m: 'eleven_flash_v2_5' }
  );
});

test('⚠️ setVoice drops the resolution cache — see the persona gotcha', async () => {
  // Without this, the new director sounds exactly like the old one, and the
  // only symptom is a wrong voice — which reads as the switch not working.
  const { m } = mouth();
  billable(m);
  await m.stream(m.speak('hello')!);
  m.setVoice('v_other');
  assert.equal((m as unknown as { resolved: unknown }).resolved, null);
  assert.equal(m.currentVoice(), 'v_other');
  // Setting the SAME voice again must not thrash the cache.
  (m as unknown as { resolved: unknown }).resolved = { voiceId: 'v_other', modelId: 'eleven_flash_v2_5' };
  m.setVoice('v_other');
  assert.ok((m as unknown as { resolved: unknown }).resolved, 'a no-op switch keeps the cache');
});
