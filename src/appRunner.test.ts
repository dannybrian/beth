import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AppRunner, detectRun, sniffUrl, attribute, type RunState } from './appRunner.ts';
import { Workbench } from './workbench.ts';

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'run', name), 'utf8');

// ⚠️ REAL banners, captured from each app's own `dev` (see CLAUDE.md on invented
// fixtures). The two traps are in them: a LAN url after the local one, and
// somebody else's server (Ollama) named further down.
test('the url is the first LOCAL one each real app prints', () => {
  assert.equal(sniffUrl(fixture('appresent2.txt')), 'http://localhost:5180/');
  assert.equal(sniffUrl(fixture('elvidrio.txt')), 'http://127.0.0.1:5178/');
  assert.equal(sniffUrl(fixture('talktree.txt')), 'http://127.0.0.1:60567/');
});

test('a LAN address, colour codes and a bind-all address', () => {
  assert.equal(sniffUrl('controller http://192.168.0.249:5180/controller'), null);
  assert.equal(sniffUrl('\x1b[32m➜\x1b[0m  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m'), 'http://localhost:5173/');
  assert.equal(sniffUrl('listening on http://0.0.0.0:8080.'), 'http://127.0.0.1:8080/');
});

test('detection takes dev, then start — the scripts the build refuses', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'run-detect-'));
  assert.equal(detectRun(repo), null);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { start: 'node s', dev: 'vite' } }));
  assert.deepEqual(detectRun(repo)?.command, ['npm', 'run', 'dev']);
  fs.writeFileSync(path.join(repo, 'pnpm-lock.yaml'), '');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { start: 'node s' } }));
  assert.deepEqual(detectRun(repo)?.command, ['pnpm', 'run', 'start']);
  assert.deepEqual(detectRun(repo, 'pnpm -C packages/harness dev')?.command, ['pnpm', '-C', 'packages/harness', 'dev']);
});

// --- real processes -------------------------------------------------------------

const SERVER = `import http from 'node:http';
const s = http.createServer((q, r) => r.end('ok'));
s.listen(Number(process.argv[2] ?? 0), '127.0.0.1', () => console.log('demo on http://127.0.0.1:' + s.address().port + '/'));
`;

function repoWithServer() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-repo-')));
  fs.writeFileSync(path.join(repo, 'server.mjs'), SERVER);
  return repo;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

/** Poll for a condition — process and socket timing have no guarantee. */
async function until<T>(fn: () => Promise<T | false> | T | false, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('condition never held');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Groups a test started, killed whatever happens. A test that fails mid-way
 * must not leave a server running — the mutation check of the group stop did
 * exactly that, which is the bug these tests exist for.
 */
const started = new Set<number>();
test.after(() => {
  for (const g of started) {
    try {
      process.kill(-g, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

function runner(repo: string, over: { runCmd?: string; runUrl?: string } = {}, bench?: Workbench) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-state-'));
  const published: RunState[] = [];
  const bus = { publish: (m: { type: string; state?: RunState }) => m.type === 'run' && published.push(m.state!) };
  const r = new AppRunner({ repo, stateDir, ...over }, bus as never, { bench, pollMs: 60_000 });
  const startApp = r.startApp.bind(r);
  r.startApp = async () => {
    const res = await startApp();
    const pgid = (r as unknown as { child: { pgid: number } | null }).child?.pgid;
    if (pgid) started.add(pgid);
    return res;
  };
  return { r, published, stateDir };
}

test('a watched app survives a "restart" and the new runner stops the WHOLE tree', async () => {
  const repo = repoWithServer();
  const port = await freePort();
  const cfg = { runCmd: `node --watch server.mjs ${port}`, runUrl: `http://127.0.0.1:${port}` };
  const bench = new Workbench({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'run-bench-')) });
  const first = runner(repo, cfg, bench);
  const started = await first.r.startApp();
  assert.ok(started.ok);
  await until(async () => (await first.r.refresh()).phase === 'running');
  assert.equal(first.r.state().owned, true);
  assert.equal(bench.current()?.url, `http://127.0.0.1:${port}/`, 'the url went on the bench');
  assert.equal(bench.current()?.source, 'run');

  // The listener is the watcher's CHILD — the reason a stop takes the group.
  const holder = await attribute(repo, port);
  assert.equal(holder.kind, 'ours');
  const listener = (holder as { pid: number }).pid;
  const watcher = (holder as { pgid: number }).pgid;
  assert.notEqual(listener, watcher);

  // A fresh runner knows nothing, and reads the truth off the port.
  first.r.close();
  const second = runner(repo, cfg, bench);
  const seen = await second.r.refresh();
  assert.equal(seen.phase, 'running');
  assert.equal(seen.owned, false, 'started by a previous harness, so no log of its own');

  const stopped = await second.r.stopApp();
  assert.ok(stopped.ok);
  assert.equal(stopped.ok && stopped.state.phase, 'stopped');
  await until(() => !alive(listener) && !alive(watcher));
  assert.equal(bench.current(), null, 'the run’s url came down with it');
});

test('a listener from ANOTHER directory is reported, never signalled', async () => {
  const repo = repoWithServer();
  const elsewhere = repoWithServer();
  const port = await freePort();
  const stranger = spawn('node', ['server.mjs', String(port)], { cwd: elsewhere, stdio: 'ignore' });
  try {
    const { r } = runner(repo, { runCmd: 'node server.mjs', runUrl: `http://127.0.0.1:${port}` });
    const s = await until(async () => {
      const st = await r.refresh();
      return st.phase === 'taken' && st;
    });
    assert.match(s.note ?? '', /not this project/);
    const start = await r.startApp();
    assert.equal(start.ok, false, 'a second copy would only die on EADDRINUSE');
    const stop = await r.stopApp();
    assert.equal(stop.ok, false);
    assert.ok(alive(stranger.pid!), 'still running — not ours to stop');
  } finally {
    stranger.kill('SIGKILL');
  }
});

test('an exit nobody asked for is the red light, with its code', async () => {
  const repo = repoWithServer();
  const { r } = runner(repo, { runCmd: 'node -e process.exit(3)' });
  assert.ok((await r.startApp()).ok);
  const s = await until(async () => {
    const st = await r.refresh();
    return st.phase === 'crashed' && st;
  });
  assert.equal(s.exit?.code, 3);
  assert.match(s.note ?? '', /code 3/);
});

test('with no url declared, the one the app prints is used for that run', async () => {
  const repo = repoWithServer();
  const { r } = runner(repo, { runCmd: 'node server.mjs 0' });
  assert.ok((await r.startApp()).ok);
  const s = await until(async () => {
    const st = await r.refresh();
    return st.phase === 'running' && st.url && st;
  });
  assert.match(s.url!, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.match(s.urlWhy ?? '', /printed/);
  assert.match(r.log()?.text ?? '', /demo on/);
  const stopped = await r.stopApp();
  assert.ok(stopped.ok && stopped.state.phase === 'stopped');
  assert.equal(stopped.ok && stopped.state.url, null, 'learned for that run only');
});

test('nothing to run is refused with what to set', async () => {
  const { r } = runner(fs.mkdtempSync(path.join(os.tmpdir(), 'run-none-')));
  const res = await r.startApp();
  assert.equal(res.ok, false);
  assert.match(res.ok ? '' : res.reason, /HARNESS_RUN_CMD/);
});
