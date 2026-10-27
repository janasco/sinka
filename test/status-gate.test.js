import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// GATE tests: the /status dashboard must not render a single inbox address
// without ADMIN_TOKEN, and must render the full dashboard with it.
// Boots the real server twice: once with a token (gate active), once
// without (legacy open behaviour the other suites rely on).

const REPO = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const SRC_PATH = path.join(REPO, 'src/index.js');
const TOKEN = 'gate-test-token-xyz';

let procs = [];
let dirs = [];

async function fetchLocal(url, opts) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(5000) });
}

async function boot(port, adminToken) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinka-gate-'));
  dirs.push(dir);
  const env = {
    PATH: process.env.PATH,
    HOME: os.tmpdir(),
    PORT: String(port),
    ADMIN_TOKEN: adminToken,
    GMAIL_USER: 'sinka-test@example.invalid',
    DATA_DIR: path.join(dir, 'data'),
    POLL_INTERVAL_MS: '3600000',
  };
  const proc = spawn(process.execPath, [SRC_PATH], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(proc);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetchLocal(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) {
        await res.arrayBuffer();
        return port;
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill('SIGKILL');
  throw new Error(`port ${port}: server did not become ready`);
}

before(async () => {
  await boot(18911, TOKEN);
  await boot(18912, '');
});

after(() => {
  for (const p of procs) {
    if (p && p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  }
  procs = [];
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

test('GET /status without a token renders the gate and leaks no address', async () => {
  const res = await fetchLocal('http://127.0.0.1:18911/status');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Private dashboard/);
  assert.match(html, /g-form/);
  assert.doesNotMatch(html, /example\.invalid/, 'inbox address rendered without a token');
  assert.doesNotMatch(html, /btn-poll/, 'dashboard controls rendered without a token');
});

test('POST /status/login rejects a wrong token and accepts the right one', async () => {
  const bad = await fetchLocal('http://127.0.0.1:18911/status/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'wrong' }),
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);
  const good = await fetchLocal('http://127.0.0.1:18911/status/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }),
  });
  assert.equal(good.status, 200);
  const setCookie = good.headers.get('set-cookie') || '';
  assert.match(setCookie, /sinka_admin=/);
  assert.match(setCookie, /httponly/i);
});

test('the login cookie unlocks the dashboard HTML and the API', async () => {
  const login = await fetchLocal('http://127.0.0.1:18911/status/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }),
  });
  const cookie = cookieOf(login);
  assert.ok(cookie.startsWith('sinka_admin='));
  const page = await fetchLocal('http://127.0.0.1:18911/status', { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /btn-poll/);
  const api = await fetchLocal('http://127.0.0.1:18911/api/status', { headers: { Cookie: cookie } });
  assert.equal(api.status, 200);
  assert.equal((await api.json()).success, true);
});

test('the API stays 401 without any credential, and logout clears the cookie', async () => {
  const api = await fetchLocal('http://127.0.0.1:18911/api/status');
  assert.equal(api.status, 401);
  const login = await fetchLocal('http://127.0.0.1:18911/status/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }),
  });
  const out = await fetchLocal('http://127.0.0.1:18911/status/logout', {
    method: 'POST', headers: { Cookie: cookieOf(login) },
  });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie') || '', /sinka_admin=;/);
});

test('with no ADMIN_TOKEN configured the dashboard stays open (legacy behaviour)', async () => {
  const res = await fetchLocal('http://127.0.0.1:18912/status');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /btn-poll/);
  const api = await fetchLocal('http://127.0.0.1:18912/api/status');
  assert.equal(api.status, 200);
});
