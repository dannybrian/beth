// Repairing a tool call the model wrote in two formats at once.
//
// ⚠️ This is not a harness bug and it cannot be fixed here — it is fixed HERE
// because here is where the damage lands. The model sometimes emits a tool call
// whose first parameter swallows the closing tag and every parameter after it,
// so the harness receives one long string and no other arguments at all:
//
//   context: "...the same class of latent break.</context>
//             <parameter name=\"options\">[\"Open a follow-up plan now\", …]"
//   options: undefined
//
// Two things were lost. The context now ends in markup, which is what Danny sees
// in the queue — and the OPTIONS are gone entirely, so a decision that came with
// four candidate answers arrives as free text. The information is all still
// there, in the string, unambiguously delimited. So take it back.
//
// The recovery is deliberately narrow: a closing tag ALONE is not enough, since
// she writes about markup and a `context` that mentions `</context>` in passing
// is an ordinary sentence. The tail has to actually be a parameter block.

/** `<parameter name="options">` — the marker that makes this a malformed call. */
const PARAM_OPEN = /<parameter\s+name="([^"]+)"\s*>/g;

/** JSON when it parses (arrays, numbers, booleans), otherwise the raw text. */
function coerce(raw: string): unknown {
  const text = raw.replace(/<\/parameter\s*>\s*$/, '').trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Every `<parameter name="x">value` block in the tail, in order. */
function parseParams(tail: string): [string, string][] {
  const found: [string, string][] = [];
  const opens = [...tail.matchAll(PARAM_OPEN)];
  for (let i = 0; i < opens.length; i++) {
    const start = opens[i].index! + opens[i][0].length;
    const end = i + 1 < opens.length ? opens[i + 1].index! : tail.length;
    found.push([opens[i][1], tail.slice(start, end)]);
  }
  return found;
}

/**
 * Give back what the string swallowed.
 *
 * Returns the arguments unchanged when nothing is wrong, which is the overwhelming
 * majority of calls. A recovered parameter never overwrites one that arrived
 * properly: if the model managed to send `options` as a real argument, that is the
 * better copy of it.
 */
export function repairArgs<T extends Record<string, any>>(args: T): { args: T; repaired: string[] } {
  const out: Record<string, unknown> = { ...args };
  const repaired: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') continue;
    const at = value.indexOf(`</${key}>`);
    if (at < 0) continue;
    const tail = value.slice(at + key.length + 3);
    // A sentence that merely mentions the tag is not a malformed call.
    if (!/^\s*<parameter\s+name="/.test(tail)) continue;
    out[key] = value.slice(0, at).trim();
    repaired.push(key);
    for (const [name, raw] of parseParams(tail)) {
      const recovered = coerce(raw);
      if (out[name] === undefined && recovered !== undefined) {
        out[name] = recovered;
        repaired.push(name);
      }
    }
  }
  return { args: out as T, repaired };
}
