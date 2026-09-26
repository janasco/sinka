import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// SERVED-PAGE tests: the dashboard as the browser actually receives it.
//
// Why this file exists
// --------------------
// `npm run check` runs `node --check` on src/index.js. That only proves the
// *file* parses. The dashboard HTML is a JS template literal, so its own
// escapes are resolved by JS *before* the bytes leave the process. An escaped
// quote written as \' inside the literal is perfectly legal there and compiles
// fine under `node --check` — but the served page then contains a bare `'` in
// the middle of a single-quoted JS string, and the browser throws
// SyntaxError: no client JavaScript runs at all. The page still looks fine as
// static HTML, which is exactly how that shipped.
//
// test/dashboard-contract.test.js slices the script out of the SOURCE text, so
// it also cannot see this: the raw slice still contains the legal \' and parses.
// Only the rendered bytes are wrong.
//
// So the rules here are:
//   A. a mechanical audit of the template region for escape sequences that
//      would silently change meaning between the source and the response; and
//   B. boot the real server in a child process and compile/run the script that
//      comes back over HTTP.
//
// Side effects: localhost only, GET only, no IMAP, no .env. The child is given
// a hand-built env (so it cannot inherit a real token), a cwd in os.tmpdir()
// (so dotenv finds no .env), and DATA_DIR inside that temp dir (so nothing is
// written into the repo). It is SIGKILLed in an after() hook.

// ------------------------------------------------------------------ helpers

const REPO = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const SRC_PATH = path.join(REPO, 'src/index.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

/** Source text of the whole `app.get('/', …)` route, template literal included. */
const ROUTE_START = SRC.indexOf("app.get('/'");
const ROUTE_END = SRC.indexOf('`);', SRC.indexOf('</html>', ROUTE_START));
assert.ok(ROUTE_START > 0 && ROUTE_END > ROUTE_START, 'could not locate the app.get(\'/\') route');
const REGION = SRC.slice(ROUTE_START, ROUTE_END);

const STYLE_OPEN = REGION.indexOf('<style>');
const STYLE_CLOSE = REGION.indexOf('</style>', STYLE_OPEN);
const STYLE = REGION.slice(STYLE_OPEN + '<style>'.length, STYLE_CLOSE);

/** Byte ranges of `content:"…"` values, where an escaped quote is CSS data. */
function cssContentRanges() {
  const out = [];
  for (const m of STYLE.matchAll(/content\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    out.push([STYLE_OPEN + m.index, STYLE_OPEN + m.index + m[0].length]);
  }
  return out;
}
const CONTENT_RANGES = cssContentRanges();
const inCssContent = (i) => CONTENT_RANGES.some(([a, b]) => i >= a && i < b);

/**
 * Quote escapes (`\'` and `\"`) found in the template region.
 *
 * THE RULE: a quote escape is a *lossy* escape. The template literal consumes
 * the backslash, the response gets a bare quote, and the served script is no
 * longer the text that was reviewed. Inside the page that is a guaranteed
 * SyntaxError; inside the stylesheet it is a data character, not a string
 * delimiter, and is therefore allowed — but only inside a `content:"…"` value.
 *
 * This is an allowlist of a known-good escape site, not a blanket ban on
 * backslashes: `\u2026` in the script and the CSS hex escapes
 * content:"\\25B8" / content:"\\25BE" in the stylesheet all survive the round
 * trip unchanged and must not be flagged.
 */
function quoteEscapes(text, { cssContent = null } = {}) {
  const hits = [];
  for (const m of text.matchAll(/\\(['"])/g)) {
    const i = m.index;
    if (cssContent && cssContent(i)) continue;
    hits.push({ at: i, seq: m[0], ctx: text.slice(Math.max(0, i - 40), i + 20).replace(/\n/g, '\\n') });
  }
  return hits;
}

/** quoteEscapes() over the real template, with the stylesheet allowlist on. */
const templateQuoteEscapes = () => quoteEscapes(REGION, {
  cssContent: (i) => i >= STYLE_OPEN && i < STYLE_CLOSE && inCssContent(i),
});

/** A minimal DOM/fetch stub. Same shape the contract suite uses. */
function stubDom({ payload, confirmResult = true } = {}) {
  const nodes = new Map();
  function node(id) {
    let n = nodes.get(id);
    if (!n) {
      const attrs = new Map();
      n = {
        id, textContent: '', className: '', innerHTML: '', hidden: false,
        value: '', disabled: false, _cls: new Set(),
        classList: {
          add: (c) => n._cls.add(c),
          remove: (c) => n._cls.delete(c),
          toggle: (c, on) => ((on === undefined ? !n._cls.has(c) : on) ? n._cls.add(c) : n._cls.delete(c)),
          contains: (c) => n._cls.has(c),
        },
        setAttribute: (k, v) => attrs.set(k, String(v)),
        getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
        removeAttribute: (k) => attrs.delete(k),
        hasAttribute: (k) => attrs.has(k),
        focus() {}, scrollIntoView() {},
        onclick: null, oninput: null,
      };
      nodes.set(id, n);
    }
    return n;
  }
  const fetches = [];
  const sandbox = {
    document: {
      hidden: false,
      getElementById: node,
      querySelector: () => null,
      addEventListener() {},
      body: { classList: { add() {}, remove() {}, toggle() {} } },
    },
    window: { matchMedia: () => ({ matches: false }) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch(url, opts) {
      fetches.push({ path: url, method: (opts && opts.method) || 'GET', body: opts && opts.body });
      return Promise.resolve({ status: 200, json: () => Promise.resolve(payload) });
    },
    // No-op timers: nothing may keep the test runner alive.
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
    clearInterval: () => {},
    confirm: () => confirmResult,
    console,
    Promise, Date, Math, JSON, String, Number, Boolean, Object, Array, RegExp,
    isNaN, parseInt, parseFloat,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return { sandbox, node, fetches, nodes };
}

const HEALTHY = {
  success: true,
  destinations: ['team1@example.com', 'team2@example.com'],
  sinkUsers: ['team1@example.com', 'team2@example.com'],
  disabledSinks: [], autoDisabledSinks: [], pendingSinks: [],
  sinksConfigured: 2,
  startedAt: '2026-01-02T02:00:00.000Z',
  lastPollAt: '2026-01-02T03:04:05.000Z',
  pollIntervalMs: 60000, seenCount: 7, consecutiveErrors: 0, setupNeeded: null,
  lastResult: { reason: 'timer', ms: 812, fetched: 2, replicated: 2, skipped: 0, details: [] },
};

const settle = () => new Promise((r) => setTimeout(r, 0));

// ================================================ A. template escape audit

test('the dashboard template contains no quote escape that would corrupt the served script', () => {
  // This is the mechanical form of the bug: `\'` inside the template literal
  // is legal here and in `node --check`, but the response loses the backslash
  // and the browser's parser sees an unterminated string.
  const hits = templateQuoteEscapes();
  assert.deepEqual(
    hits.map((h) => h.ctx),
    [],
    `template region uses ${hits.length} quote escape(s) (\' or \"); the served bytes differ from the reviewed bytes. `
    + 'Write a real Unicode escape (\\u2019) or restructure the string instead.'
  );
});

test('the escape audit is not vacuous: it still flags a quote escape like the one that shipped', () => {
  // Guards the rule above: a detector that finds nothing because it is broken
  // is worse than no test. This is the exact shape that reached production in
  // afd5fc0 — a `\"` inside the inline script's selector-building string.
  const historical = 'var t=list.filter(function(s){return s.sel==="a\\\\"b";});';
  const hits = quoteEscapes(historical);
  assert.equal(hits.length, 1, 'a \\" inside the script region must be reported');
  assert.equal(hits[0].seq, '\\"');

  const benign = 'var DASH="\\u2014";setText("cd",30);';
  assert.deepEqual(quoteEscapes(benign), [], '\\uXXXX escapes are lossless and must not be reported');

  // The same escape is accepted when it sits inside a CSS content value,
  // because there the quote is a data character rather than a delimiter.
  const cssOk = '<style>a::before{content:"\\"x\\"";}</style>';
  const off = cssOk.indexOf('content:');
  assert.deepEqual(quoteEscapes(cssOk, { cssContent: (i) => i >= off && i < cssOk.indexOf('}', off) }), []);
});

test('every backslash in the stylesheet is a CSS escape, never a stray quote escape', () => {
  // The two allowlisted escapes are CSS hex escapes: content:"\\25B8" and
  // content:"\\25BE" (the ▸ / ▾ disclosure triangles). Those are `\\` + hex
  // digits, so they are a different class from a quote escape and are checked
  // on their own terms: the stylesheet must be fully covered by CSS escape
  // sequences, leaving no unexplained backslash behind.
  const covered = /\\{1,2}[0-9a-fA-F]{1,6}[ \t]?/g;
  let cursor = 0;
  for (const m of STYLE.matchAll(covered)) {
    const gap = STYLE.slice(cursor, m.index);
    assert.doesNotMatch(gap, /\\/, `unexplained backslash in the stylesheet near: ${JSON.stringify(gap.slice(-60))}`);
    cursor = m.index + m[0].length;
  }
  assert.doesNotMatch(STYLE.slice(cursor), /\\/, 'trailing unexplained backslash in the stylesheet');

  // And the two triangles are still there and still spelled as CSS escapes.
  for (const glyph of ['\\\\25B8', '\\\\25BE']) {
    assert.ok(STYLE.includes(`"${glyph}"`), `expected content:"${glyph}" disclosure-triangle escape`);
  }
});

// ================================================ B. the real served page

const CANDIDATE_PORTS = [18805, 18806, 18807];
const BOOT_TIMEOUT_MS = 20000;

let child = null;
let tmpDir = null;
let servedHtml = null;
let servedScript = null;

/** Redact anything token-shaped before it can reach a test failure message. */
function redact(s) {
  return String(s).slice(0, 600).replace(/[A-Za-z0-9_\-]{20,}/g, '<redacted>');
}

async function fetchLocal(url) {
  return fetch(url, { signal: AbortSignal.timeout(5000) });
}

/** Boot the app with no credentials and wait for /healthz. Never throws. */
async function tryBoot(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinka-served-page-'));
  // Hand-built env: nothing is inherited, so no real token can reach the child
  // and `ADMIN_TOKEN` is empty (auth is a no-op). GMAIL_APP_PASSWORD is
  // absent on purpose -> preview mode -> the poll loop short-circuits and no
  // IMAP socket is ever opened. cwd is the temp dir, so dotenv finds no .env.
  const env = {
    PATH: process.env.PATH,
    HOME: os.tmpdir(),
    PORT: String(port),
    ADMIN_TOKEN: '',
    GMAIL_USER: 'sinka-test@example.invalid',
    DATA_DIR: path.join(dir, 'data'),
    POLL_INTERVAL_MS: '3600000',
  };
  assert.ok(!('GMAIL_APP_PASSWORD' in env), 'the child must never be given a mail password');
  const proc = spawn(process.execPath, [SRC_PATH], {
    cwd: dir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  let exited = null;
  proc.on('exit', (code, signal) => { exited = { code, signal }; });

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline && !exited) {
    try {
      const res = await fetchLocal(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) {
        await res.arrayBuffer();
        return { proc, dir, log: () => log };
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill('SIGKILL');
  return { error: `port ${port}: server did not become ready. exit=${JSON.stringify(exited)} log=${redact(log)}` };
}

// Hard ceiling: BOOT_TIMEOUT_MS per candidate port plus a 5s cap on every HTTP
// call, so this hook cannot hang the suite even if the server never comes up.
before(async () => {
  const failures = [];
  for (const port of CANDIDATE_PORTS) {
    const r = await tryBoot(port);
    if (r.error) { failures.push(r.error); continue; }
    child = r.proc;
    tmpDir = r.dir;
    const res = await fetchLocal(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200, 'GET / must answer 200');
    servedHtml = await res.text();
    return;
  }
  assert.fail(`could not boot sinka on any of ${CANDIDATE_PORTS.join(', ')}.\n${failures.join('\n')}`);
});

after(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  child = null;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

test('the served HTML carries exactly one inline script, so extraction is unambiguous', () => {
  assert.ok(servedHtml, 'the served page was not captured');
  const opens = servedHtml.match(/<script\b/gi) || [];
  const closes = servedHtml.match(/<\/script>/gi) || [];
  assert.equal(opens.length, 1, `expected one inline <script>, found ${opens.length}`);
  assert.equal(closes.length, 1, `expected one </script>, found ${closes.length}`);
  assert.doesNotMatch(servedHtml, /<script[^>]+src=/i, 'the dashboard must not depend on an external script');
  servedScript = servedHtml.slice(
    servedHtml.indexOf('<script>') + '<script>'.length,
    servedHtml.indexOf('</script>')
  );
  assert.ok(servedScript.length > 5000, 'the extracted script looks truncated');
});

test('the script served by the server parses as JavaScript', () => {
  // THE regression test for the shipped bug. `node --check src/index.js` passed
  // while the response was unparseable; only these bytes can catch it.
  let err = null;
  try {
    new vm.Script(servedScript, { filename: 'served-dashboard.js' });
  } catch (e) {
    err = e;
  }
  assert.equal(
    err, null,
    `the served <script> does not parse: ${err && err.message}. `
    + 'The page ships with no working JavaScript while still looking correct as static HTML.'
  );
});

test('the served script runs to completion and defines its public functions', () => {
  const { sandbox } = stubDom({ payload: HEALTHY });
  assert.doesNotThrow(() => vm.runInContext(servedScript, sandbox, { filename: 'served-dashboard.js' }));
  // Top-level `var`/`function` in a classic script become globals, so their
  // presence proves the body executed, not merely that it compiled.
  for (const name of ['refresh', 'api', 'render', 'el', 'setText', 'arr', 'num', 'str', 'h', 'tick']) {
    assert.equal(typeof sandbox[name], 'function', `served script did not define ${name}() — it threw or never ran`);
  }
  assert.equal(sandbox.REFRESH_SECS, 30, 'served script top level did not run to its last statement');
});

test('the served script boots, paints a verdict, and asks for /api/status with GET', async () => {
  const { sandbox, node, fetches } = stubDom({ payload: HEALTHY });
  vm.runInContext(servedScript, sandbox, { filename: 'served-dashboard.js' });
  await settle();
  assert.equal(fetches.length, 1, 'the page must ask the server for its numbers on load');
  assert.deepEqual({ path: fetches[0].path, method: fetches[0].method }, { path: '/api/status', method: 'GET' });
  assert.equal(node('hero-t').textContent, 'Everything is working');
});

// ============================================ C. verbs of the served wiring

test('the served wiring sends the verb the server actually registers', async () => {
  // Bug (b): api() used to pick its verb from the presence of a body, so the
  // poll-now and baseline buttons — called with no body — issued GET to routes
  // the server only registers for POST. Asserted on recorded calls against the
  // SERVED script, not on source text.
  const { sandbox, node, fetches } = stubDom({ payload: HEALTHY, confirmResult: true });
  vm.runInContext(servedScript, sandbox, { filename: 'served-dashboard.js' });
  await settle();
  fetches.length = 0;

  node('btn-poll').onclick();
  await settle();
  node('btn-base').onclick();
  await settle();
  node('btn-refresh').onclick();
  await settle();

  const byPath = new Map();
  for (const f of fetches) byPath.set(f.path, f.method);
  assert.equal(byPath.get('/api/poll-now'), 'POST', '"Check for mail now" must POST /api/poll-now');
  assert.equal(byPath.get('/api/baseline'), 'POST', '"Skip the backlog" must POST /api/baseline');
  assert.equal(byPath.get('/api/status'), 'GET', 'the refresh must GET /api/status');
  for (const [p, verb] of byPath) {
    assert.ok(['GET', 'POST'].includes(verb), `unexpected verb ${verb} for ${p}`);
  }
});

test('every endpoint the client calls is registered on the server with the same verb', () => {
  // The general form of bug (b): instead of hardcoding a list, compare the
  // client's api() call sites against the server's route table. Any future
  // endpoint added on one side only, or with a mismatched verb, fails here.
  const serverRoutes = new Map();
  for (const m of SRC.matchAll(/\bapp\.(get|post)\(\s*'(\/api\/[^']*)'/g)) {
    const verb = m[1].toUpperCase();
    if (serverRoutes.has(m[2]) && serverRoutes.get(m[2]) !== verb) {
      throw new Error(`server registers ${m[2]} twice with different verbs`);
    }
    serverRoutes.set(m[2], verb);
  }
  assert.ok(serverRoutes.size >= 4, `expected the /api route table, found ${serverRoutes.size}`);

  const clientCalls = new Map();
  for (const m of servedScript.matchAll(/\bapi\(\s*'(\/api\/[^']*)'\s*([^)]*)\)/g)) {
    const method = /method\s*:\s*'([A-Z]+)'/.exec(m[2]);
    assert.ok(method, `api('${m[1]}',${m[2]}) has no explicit method; the verb must never be inferred from a body`);
    clientCalls.set(m[1], method[1].toUpperCase());
  }
  assert.ok(clientCalls.size >= 3, `expected several client endpoints, found ${clientCalls.size}`);

  for (const [p, verb] of clientCalls) {
    assert.equal(serverRoutes.get(p), verb,
      `the client calls ${p} with ${verb}, but the server registers ${serverRoutes.get(p) ?? 'nothing'}`);
  }
});
