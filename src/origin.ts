// Cross-site request forgery is the one browser attack loopback never had to
// answer: nothing off the machine could POST at all. A tailnet proxy changes
// that premise without touching the bind — `tailscale serve` forwards remote
// traffic to 127.0.0.1, so "reachable" no longer means "on this machine". The
// tailnet keeps strangers out, but a malicious page open in a browser ON a
// tailnet device can fire a "simple" cross-site POST (text/plain, no preflight)
// at the harness's hostname, and it executes server-side even though the
// response is unreadable. These endpoints reach a session running a shell.
//
// The one thing such a page cannot forge is the Origin header the browser
// stamps on every fetch/XHR POST. So the rule is: no Origin (curl, scripts —
// CSRF is a browser attack) passes; an Origin whose host matches the Host
// header (i.e. the page we ourselves served, by whatever name it reached us)
// passes; anything else is refused before dispatch. Comparing against Host
// rather than a fixed list is what lets the same check hold for
// 127.0.0.1:4620 and for a ts.net hostname the harness has never heard of —
// verified 2026-08-26 that `tailscale serve` preserves the original Host.

/** True when a request with this Origin header may reach a write endpoint. */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  // Sandboxed iframes and privacy-stripped redirects send the literal string
  // "null" — an opaque origin is exactly what a forged write looks like.
  if (origin === 'null') return false;
  if (!host) return false;
  let originHost: string;
  let hostHost: string;
  try {
    originHost = new URL(origin).hostname;
    // The Host header has no scheme; borrow one so ports and IPv6 brackets
    // parse the same way on both sides of the comparison.
    hostHost = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  return originHost !== '' && originHost === hostHost;
}
