// Both wrong answers here are silent: too strict and the tailnet page's own
// POSTs come back 403 — the UI just stops working remotely with nothing in any
// log — and too loose a cross-site page writes turns as Danny. The Host values
// are the real ones observed through `tailscale serve` (2026-08-26), which
// preserves the original Host header rather than rewriting it to the loopback
// target — the fact the whole compare-against-Host design rests on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { originAllowed } from './origin.ts';

test('non-browser clients pass: no Origin header at all', () => {
  // curl, scripts, the harness's own internal calls. CSRF is a browser attack.
  assert.equal(originAllowed(undefined, '127.0.0.1:4620'), true);
  assert.equal(originAllowed(undefined, undefined), true);
});

test('the pages we serve pass, by whichever name they reached us', () => {
  for (const [origin, host] of [
    // The local tab.
    ['http://127.0.0.1:4620', '127.0.0.1:4620'],
    ['http://localhost:4620', 'localhost:4620'],
    // The tailnet tab, through `tailscale serve` (real observed Host).
    ['https://macbook-air-6.tail63e175.ts.net', 'macbook-air-6.tail63e175.ts.net'],
    // A serve config on a non-443 port keeps the port in both.
    ['https://macbook-air-6.tail63e175.ts.net:8443', 'macbook-air-6.tail63e175.ts.net:8443'],
    // IPv6 loopback, brackets and all.
    ['http://[::1]:4620', '[::1]:4620'],
  ] as const) {
    assert.equal(originAllowed(origin, host), true, `${origin} vs ${host}`);
  }
});

test('a cross-site page is refused whatever it says', () => {
  const host = 'macbook-air-6.tail63e175.ts.net';
  for (const origin of [
    'https://evil.example',
    // Prefix/suffix confusions of the real name.
    'https://macbook-air-6.tail63e175.ts.net.evil.example',
    'https://evil-macbook-air-6.tail63e175.ts.net.example',
    // Sandboxed iframes and privacy-stripped redirects send literal "null".
    'null',
    // Garbage that must fail closed, not throw.
    'not a url',
    '',
  ]) {
    assert.equal(originAllowed(origin, host), false, origin);
  }
});

test('an Origin with no Host to compare against fails closed', () => {
  assert.equal(originAllowed('https://macbook-air-6.tail63e175.ts.net', undefined), false);
  assert.equal(originAllowed('https://macbook-air-6.tail63e175.ts.net', ''), false);
});

test('the port is part of neither side of the comparison', () => {
  // Scheme and port differ between the page (https, 443) and any future proxy
  // shape; the HOST is the identity. A cross-site attacker controls neither.
  assert.equal(originAllowed('https://macbook-air-6.tail63e175.ts.net', 'macbook-air-6.tail63e175.ts.net:8443'), true);
});
