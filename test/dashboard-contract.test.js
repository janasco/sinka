import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Dashboard contract tests.
//
// src/index.js is read as TEXT only. Nothing here boots the server, opens a
// socket, or reads .env / data — so the suite is network-free, needs no
// credentials, and cannot print a secret. The HTML template is a JS template
// literal, so it is sliced out statically; the inline <script> block is then
// run inside a `node:vm` sandbox with a tiny fake DOM so the real copy and the
// real click wiring can be asserted without a browser.

// ---------------------------------------------------------------- extraction

const SRC = fs.readFileSync(
  path.join(path.resolve(fileURLToPath(new URL('../', import.meta.url))), 'src/index.js'),
  'utf8'
);

const TEMPLATE_START = SRC.indexOf('<!doctype html>');
const TEMPLATE_END = SRC.indexOf('`);', SRC.indexOf('</html>'));
assert.ok(TEMPLATE_START > 0 && TEMPLATE_END > TEMPLATE_START, 'could not find the HTML template literal');

const TEMPLATE = SRC.slice(TEMPLATE_START, TEMPLATE_END);
const S_OPEN = TEMPLATE.indexOf('<script>');
const S_CLOSE = TEMPLATE.indexOf('</script>', S_OPEN);
assert.ok(S_OPEN > 0 && S_CLOSE > S_OPEN, 'could not find the inline <script> block');

/** The inline script, verbatim. It contains no `${}` interpolation, so the raw
 *  slice is exactly the bytes the browser runs. */
const SCRIPT = TEMPLATE.slice(S_OPEN + '<script>'.length, S_CLOSE);

/** The server-rendered markup with the inline script removed. Splitting here
 *  keeps the dynamic ` id="step-'+n+'"` fragment inside the script from being
 *  mistaken for a real id, and keeps client-only strings out of the "operator
 *  can see this copy" checks. */
const MARKUP = TEMPLATE.slice(0, S_OPEN) + TEMPLATE.slice(S_CLOSE + '</script>'.length);

const STYLE = /<style>([\s\S]*?)<\/style>/.exec(MARKUP)[1];

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', middot: '\u00b7',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', rarr: '\u2192', larr: '\u2190',
  ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019', times: '\u00d7',
};
/** Decode named/numeric entities so copy checks run against what is rendered. */
function decode(html) {
  return html.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') return String.fromCodePoint(parseInt(body[1] === 'x' ? body.slice(2) : body.slice(1), body[1] === 'x' ? 16 : 10));
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}
/** Decode `\uXXXX` escapes so copy checks run against the real character. */
function unescapeJs(src) {
  return src.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
/** Everything the operator actually reads, entities and JS escapes resolved. */
const VISIBLE = decode(MARKUP);
const VISIBLE_SCRIPT = unescapeJs(decode(SCRIPT));
/** Both halves: some copy (the tile legend note) is server-side first paint and
 *  some only exists after the client renders, but the operator reads both. */
const PAGE_COPY = `${VISIBLE}\n${VISIBLE_SCRIPT}`;

const MARKUP_IDS = [...MARKUP.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

/** Ids the inline script depends on: el('x'), setText('x', …),
 *  document.getElementById('x') and the BUTTONS array it disables while busy. */
function requiredScriptIds() {
  const ids = new Set();
  for (const m of SCRIPT.matchAll(/(?:^|[^\w.])(?:el|setText|getElementById)\(\s*(['"])([A-Za-z0-9_-]+)\1/g)) ids.add(m[2]);
  const buttons = /var BUTTONS=\[([^\]]*)\]/.exec(SCRIPT);
  if (buttons) for (const m of buttons[1].matchAll(/(['"])([A-Za-z0-9_-]+)\1/g)) ids.add(m[2]);
  return ids;
}

const CRITICAL_IDS = [
  'hero', 'hero-face', 'hero-t', 'hero-s', 'srcdot', 'pipe-state', 'conduit', 'dests',
  'd-count', 'cd', 'upd', 'c-last', 'c-last-s', 'c-fetched', 'c-repl', 'c-skip', 'c-seen',
  'c-int', 'c-up', 'b-sinks', 'alerts', 'details', 'result', 'btn-refresh', 'btn-poll',
  'btn-base', 'btn-test', 'inp-to', 'inp-token',
];

const ENDPOINTS = ['/api/status', '/api/poll-now', '/api/baseline', '/api/test-forward'];

/** (selector, body) for every rule in the inline stylesheet. */
function cssRules() {
  return [...STYLE.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({ sel: sel.trim(), body }));
}

/** The body of the prefers-reduced-motion block, '' when there is none. */
const REDUCED_BLOCK = (() => {
  const at = STYLE.search(/@media\s*\(\s*prefers-reduced-motion/);
  if (at < 0) return '';
  const rest = STYLE.slice(at);
  const end = rest.slice(1).search(/@media|@keyframes/);
  return end < 0 ? rest : rest.slice(0, end + 1);
})();

// ------------------------------------------------------------- vm sandbox

/** A healthy, fully-configured status payload. Synthetic — no real addresses. */
function healthyPayload(over = {}) {
  return {
    success: true,
    destinations: ['team1@example.com', 'team2@example.com'],
    sinkUsers: ['team1@example.com', 'team2@example.com'],
    disabledSinks: [],
    autoDisabledSinks: [],
    pendingSinks: [],
    sinksConfigured: 2,
    lastPollAt: '2026-01-02T03:04:05.000Z',
    startedAt: '2026-01-02T02:00:00.000Z',
    pollIntervalMs: 60000,
    seenCount: 7,
    consecutiveErrors: 0,
    setupNeeded: null,
    lastResult: { reason: 'timer', ms: 812, fetched: 2, replicated: 2, skipped: 0, details: [] },
    ...over,
  };
}

/**
 * Run the inline script against a fake DOM. Every el() lookup returns a real
 * stub node so the script's copy and class writes are observable, and fetch is
 * spied on so button wiring can be asserted.
 */
function boot({ payload = healthyPayload(), confirmResult = true } = {}) {
  const nodes = new Map();
  function node(id) {
    let n = nodes.get(id);
    if (!n) {
      const attrs = new Map();
      n = {
        id, textContent: '', className: '', innerHTML: '', hidden: false,
        value: '', disabled: false, _cls: new Set(),
        classList: {
          add(c) { n._cls.add(c); },
          remove(c) { n._cls.delete(c); },
          toggle(c, on) { (on === undefined ? !n._cls.has(c) : on) ? n._cls.add(c) : n._cls.delete(c); },
          contains(c) { return n._cls.has(c); },
        },
        setAttribute(k, v) { attrs.set(k, String(v)); },
        getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
        removeAttribute(k) { attrs.delete(k); },
        hasAttribute(k) { return attrs.has(k); },
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
    fetch(path, opts) {
      fetches.push({ path, method: (opts && opts.method) || 'GET', body: opts && opts.body });
      return Promise.resolve({ status: 200, json: () => Promise.resolve(payload) });
    },
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
    confirm: () => confirmResult,
    console,
    Promise, Date, Math, JSON, String, Number, Boolean, Object, Array, RegExp,
    isNaN, parseInt, parseFloat,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox, { filename: 'inline-dashboard.js' });
  return { sandbox, node, fetches, nodes };
}

/** Let the script's initial `refresh()` promise chain settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

// ============================================================== 1. structure

test('the inline <script> block still parses as JavaScript', () => {
  // Compiling (not running) is the cheap structural check; boot() below is the
  // behavioural one. A SyntaxError here means the page would ship dead JS.
  assert.doesNotThrow(() => new vm.Script(SCRIPT, { filename: 'inline-dashboard.js' }));
  assert.match(SCRIPT, /\bfunction render\s*\(/);
});

test('the inline script runs to completion and paints a first verdict', async () => {
  const { node, fetches } = boot();
  await settle();
  assert.equal(fetches.length, 1, 'the page must ask the server for its numbers on load');
  assert.equal(fetches[0].path, '/api/status');
  assert.equal(node('hero-t').textContent, 'Everything is working');
});

test('every id the inline script looks up exists in the server-rendered template', () => {
  const required = [...requiredScriptIds()];
  assert.ok(required.length >= 40, `expected a large id surface, found ${required.length}`);
  const missing = required.filter((id) => !MARKUP_IDS.includes(id));
  assert.deepEqual(missing, [], `script reads ids that the template never renders: ${missing.join(', ')}`);
});

test('the known critical operator-facing ids are present and actually wired up', () => {
  const required = requiredScriptIds();
  const absent = CRITICAL_IDS.filter((id) => !MARKUP_IDS.includes(id));
  assert.deepEqual(absent, [], `critical ids missing from the template: ${absent.join(', ')}`);
  const unwired = CRITICAL_IDS.filter((id) => !required.has(id));
  assert.deepEqual(unwired, [], `critical ids the inline script no longer reads: ${unwired.join(', ')}`);
});

test('the template has no duplicate id attribute', () => {
  // Dynamic client-side ids (step-1..3, per-result tiles) are excluded by
  // slicing the script out; what is left is what the server ships, and a
  // duplicate there is always a bug regardless of ordering.
  const seen = new Set();
  const dups = new Set();
  for (const id of MARKUP_IDS) {
    if (seen.has(id)) dups.add(id);
    seen.add(id);
  }
  assert.deepEqual([...dups], []);
  assert.ok(MARKUP_IDS.length > 40, 'the id surface collapsed — template probably truncated');
});

test('every form input and button is reachable by the inline script', () => {
  const ids = [...MARKUP.matchAll(/<(?:button|input)\b[^>]*\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 8, `expected the action controls, found ${ids.length}`);
  const orphan = ids.filter((id) => !requiredScriptIds().has(id));
  assert.deepEqual(orphan, [], `controls with no client wiring: ${orphan.join(', ')}`);
  // Each label must point at a real input.
  for (const m of MARKUP.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)) {
    assert.ok(MARKUP_IDS.includes(m[1]), `label points at a missing control: ${m[1]}`);
  }
});

// ================================================================ 2. honesty

test('the unreachable verdict says plainly that the page cannot vouch for the numbers', () => {
  const { sandbox, node } = boot();
  sandbox.netDown(new Error('socket hang up'));
  const line = node('hero-t').textContent;
  assert.match(line, /can'?t reach sinka/i, `unreachable verdict reads: ${JSON.stringify(line)}`);
  // It must not read as a healthy or merely-stale state.
  assert.doesNotMatch(line, /everything is working|up to date|still working/i);
  assert.match(node('hero').className, /\bdown\b/, 'the hero must get the down state class');
  assert.match(node('hero-s').textContent, /cannot talk to sinka/i);
  assert.match(node('upd').textContent, /stopped moving/i);
  assert.match(node('d-count').textContent, /out of reach|not moving/i);
});

test('the working verdict still says everything is working', async () => {
  const { node } = boot();
  await settle();
  assert.equal(node('hero-t').textContent, 'Everything is working');
  assert.match(node('hero').className, /\bok\b/);
  assert.match(node('hero-s').textContent, /being copied/i);
});

test('a broken install must not be reported as working', () => {
  const { sandbox, node } = boot({ payload: healthyPayload({ lastResult: { reason: 'timer', error: 'IMAP disconnected' } }) });
  sandbox.render(healthyPayload({ lastResult: { reason: 'timer', error: 'IMAP disconnected' } }));
  assert.match(node('hero').className, /\berr\b/);
  assert.match(node('hero-t').textContent, /did not finish|need/i);
});

test('the countdown label is the page redraw, not the mail-check timer', () => {
  // Robust formulation: rather than pinning the exact sentence, this asserts
  // the label makes no mail/poll claim and that the note beside it says the
  // countdown only redraws. Re-wording the label stays green; claiming the
  // countdown is the mail check turns this red.
  const label = /<p class="k">([^<]*)<\/p>\s*<p class="v"><span id="cd">/.exec(MARKUP);
  assert.ok(label, 'could not find the countdown label next to #cd');
  const text = decode(label[1]).trim();
  assert.match(text, /this page updates in/i);
  assert.doesNotMatch(text, /mail|check|poll|inbox/i, `countdown label claims to be the mail timer: ${text}`);

  const note = /<p class="s" id="cd-note">([^<]*)<\/p>/.exec(MARKUP);
  assert.ok(note, 'the countdown must carry an explanatory note');
  assert.match(decode(note[1]), /redraws these numbers only/i);
  // The real mail interval is labelled separately, so the two are not confused.
  assert.match(VISIBLE, /sinka checks mail on its own own?\s*timer|checks mail on its own timer/i);
  assert.match(VISIBLE, /Checks every/);
  assert.match(VISIBLE, /this page's own redraw timer/i);
});

test('the page states that nothing it shows is estimated', () => {
  assert.match(PAGE_COPY, /nothing on this page is estimated/i);
  assert.match(PAGE_COPY, /every count starts at zero/i);
  assert.match(PAGE_COPY, /until a copy really lands/i);
  // Losing the server must say so rather than let stale numbers look live.
  assert.match(PAGE_COPY, /lost the server/i);
  // Robust: rather than pinning the exact value, the frozen rule must actually
  // dim things (opacity below 1), which is what stops stale numbers looking live.
  const frozen = cssRules().filter((r) => /body\.frozen/.test(r.sel));
  assert.ok(frozen.length >= 1, 'no frozen style');
  const dimmed = frozen.some((r) => {
    const o = /opacity:\s*([\d.]+)/.exec(r.body);
    return o && Number(o[1]) < 1;
  });
  assert.ok(dimmed, 'frozen numbers are not dimmed, so they still look live');
  assert.match(STYLE, /body\.frozen[^{]*\{[^}]*saturate\(/);
});

test('the checklist never ticks itself without evidence from the server', () => {
  const { sandbox, node } = boot();
  // Drive it through the real unreachable path so the wording under test is the
  // dashboard's own, not a string this test supplied.
  sandbox.netDown(new Error('socket hang up'));
  const unknown = node('steps').innerHTML;
  assert.equal((unknown.match(/class="ck /g) || []).length, 3, 'all three steps must still be shown');
  assert.doesNotMatch(unknown, /ck on/, 'nothing may be ticked while the server is unreachable');
  assert.match(unknown, /cannot say yet/i);
  assert.match(unknown, /out of reach/i);
  // The three steps are still listed, just honestly unticked.
  for (const title of ['sinka is signed in to the source inbox', 'A copy has really landed']) {
    assert.match(unknown, new RegExp(title, 'i'), `step missing from the checklist: ${title}`);
  }

  // A genuinely healthy install, on the other hand, earns all three ticks.
  sandbox.render(healthyPayload());
  assert.equal((node('steps').innerHTML.match(/ck on/g) || []).length, 3);
});

// =============================================================== 3. actions

test('every operator button is wired, and reaches its documented endpoint', async () => {
  const { node, fetches } = boot();
  await settle();
  fetches.length = 0;

  const wiring = [
    ['btn-refresh', '/api/status'],
    ['btn-poll', '/api/poll-now'],
    ['btn-poll-fix', '/api/poll-now'],
    ['btn-test', '/api/test-forward'],
    ['btn-test-fix', '/api/test-forward'],
  ];
  for (const [id] of wiring) {
    assert.equal(typeof node(id).onclick, 'function', `#${id} has no click handler`);
  }
  for (const [id, endpoint] of wiring) {
    fetches.length = 0;
    node(id).onclick();
    await settle();
    // The action endpoint must be called first; the only other call a button
    // may make is the status redraw that follows it.
    assert.equal(fetches[0] && fetches[0].path, endpoint, `#${id} should call ${endpoint}`);
    const extra = fetches.slice(1).map((f) => f.path).filter((p) => p !== '/api/status');
    assert.deepEqual(extra, [], `#${id} called something unexpected: ${extra.join(', ')}`);
  }
  assert.equal(typeof node('btn-base').onclick, 'function', '#btn-base has no click handler');
});

test('the four action endpoints are still registered as server routes', () => {
  for (const ep of ENDPOINTS) {
    assert.match(SRC, new RegExp(`app\\.(get|post)\\('${ep}'`), `no route registered for ${ep}`);
  }
  // Every endpoint the inline script can call is a real route.
  for (const ep of [...new Set([...SCRIPT.matchAll(/api\('([^']+)'/g)].map((m) => m[1]))]) {
    assert.ok(SRC.includes(`'${ep}'`), `inline script calls unregistered path ${ep}`);
  }
});

test('the four action endpoints are documented for the operator in the footer', () => {
  for (const ep of ENDPOINTS) {
    assert.ok(VISIBLE.includes(ep), `${ep} is not listed in the operator-facing footer`);
  }
  // The destructive one is called out as such, and as confirm-first.
  assert.match(VISIBLE, /This one cannot be undone/i);
  assert.match(VISIBLE, /It asks you to confirm first/i);
  assert.match(VISIBLE, /Asks you to confirm/i);
  // The countdown is not sold as the mail check anywhere in the docs.
  assert.match(VISIBLE, /this page's own redraw timer/i);
  assert.match(VISIBLE, /there is no sending path/i);
});

test('the private token is typed into a password field and never echoed back', () => {
  const input = /<input[^>]*\sid="inp-token"[^>]*>/.exec(MARKUP);
  assert.ok(input, 'no #inp-token field');
  assert.match(input[0], /type="password"/, 'the private token must not be a visible text field');
  assert.doesNotMatch(input[0], /\bvalue="[^"]+"/, 'the server must not prefill a token');
  assert.match(VISIBLE, /never written to disk|held in memory only|keeps it in memory/i);
});

test('the backlog action is guarded by a confirm() the operator must accept', async () => {
  const declined = boot({ confirmResult: false });
  await settle();
  declined.fetches.length = 0;
  declined.node('btn-base').onclick();
  await settle();
  assert.deepEqual(declined.fetches, [], 'declining the confirm must not call /api/baseline');

  const accepted = boot({ confirmResult: true });
  await settle();
  accepted.fetches.length = 0;
  accepted.node('btn-base').onclick();
  await settle();
  assert.equal(accepted.fetches[0] && accepted.fetches[0].path, '/api/baseline');
  assert.match(SCRIPT, /if\s*\(\s*!\s*confirm\(/, 'the guard must be an explicit early return on confirm()');
});

test('the backlog and poll-now actions send POST, matching the registered routes', async () => {
  // PROMOTED from test.todo. api() used to infer its verb from the presence of a
  // body, so these two call sites — invoked with no body — issued GET to routes
  // the server registers only as POST. Both buttons failed against a real
  // server while every other assertion in this file still passed.
  //
  // Asserted on the calls the stubbed fetch actually receives, not on the
  // source text: a method:'POST' literal somewhere in the file proves nothing
  // about what the button does.
  const booted = boot({ confirmResult: true });
  await settle();
  booted.fetches.length = 0;
  booted.node('btn-poll').onclick();
  await settle();
  booted.node('btn-base').onclick();
  await settle();
  booted.node('btn-poll-fix').onclick();
  await settle();
  booted.node('btn-refresh').onclick();
  await settle();

  // runAction re-reads the status afterwards, so /api/status is asked for more
  // than once. What matters is that every call to a given route carries the one
  // verb the server accepts.
  const verbsFor = (p) => booted.fetches.filter((f) => f.path === p).map((f) => f.method);
  const onlyVerb = (p, verb) => {
    const seen = verbsFor(p);
    assert.ok(seen.length > 0, `${p} was never called, so the wiring is not being exercised`);
    assert.deepEqual([...new Set(seen)], [verb], `every call to ${p} must use ${verb}, saw ${JSON.stringify(seen)}`);
    return seen.length;
  };
  assert.equal(onlyVerb('/api/poll-now', 'POST'), 2, 'both "Check for mail now" buttons must reach /api/poll-now');
  onlyVerb('/api/baseline', 'POST');
  onlyVerb('/api/status', 'GET');

  // The server side, so the expectation is anchored to the routes rather than
  // to a hand-written list that could drift with them.
  for (const [route, verb] of [['poll-now', 'POST'], ['baseline', 'POST'], ['status', 'GET']]) {
    assert.match(SRC, new RegExp(`app\\.${verb.toLowerCase()}\\('/api/${route}'`),
      `the server no longer registers /api/${route} as ${verb}, so this expectation needs revisiting`);
  }
});

test('the whole busy-button list is real, so no button stays stuck disabled', () => {
  const buttons = [...MARKUP.matchAll(/<button\b[^>]*\sid="([^"]+)"/g)].map((m) => m[1]);
  // Read the BUTTONS array itself, not every id the script mentions: a button
  // dropped from BUTTONS is still wired, it just never re-enables.
  const busy = [...(/var BUTTONS=\[([^\]]*)\]/.exec(SCRIPT)[1]).matchAll(/(['"])([A-Za-z0-9_-]+)\1/g)].map((m) => m[2]);
  const actionButtons = buttons.filter((id) => id.startsWith('btn-'));
  assert.ok(actionButtons.length >= 6, `expected the action buttons, found ${actionButtons.length}`);
  for (const id of actionButtons) {
    assert.ok(busy.includes(id), `#${id} is not in BUTTONS, so it stays disabled forever after one use`);
  }
  // No stale entries either: disabling a missing id is a silent no-op that
  // hides the real problem.
  assert.deepEqual(busy.filter((id) => !MARKUP_IDS.includes(id)), [], 'BUTTONS names ids the page does not have');
});

// ================================================================ 4. hygiene

test('the dashboard pulls in no external asset', () => {
  // Scoped to the template, not the whole file: the server legitimately calls
  // ntfy.sh for outage alerts, which has nothing to do with the page.
  const page = TEMPLATE;
  assert.doesNotMatch(page, /https?:\/\//i, 'the page must not reference an absolute URL');
  for (const tag of ['img', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'link', 'use']) {
    assert.doesNotMatch(page, new RegExp(`<${tag}\\b`, 'i'), `page must not contain a <${tag}> element`);
  }
  assert.doesNotMatch(page, /<script\b[^>]*\bsrc=/i, 'the inline script must stay inline');
  // Every hyperlink stays inside the page.
  for (const m of page.matchAll(/\shref="([^"]*)"/g)) {
    assert.ok(m[1].startsWith('#'), `external or empty href: ${m[1]}`);
  }
  assert.equal((page.match(/<style\b/g) || []).length, 1, 'styles must stay inline');
});

test('no emoji-presentation characters in operator-facing copy', () => {
  // Characters whose Unicode default presentation is an emoji, plus the
  // selectors that force one (VS-16, keycap, regional indicators). The
  // geometric/dingbat glyphs the design uses for status (● ◐ ◌ ✓ ✕ ○ ▸) are
  // Emoji_Presentation=No in Unicode and so sit outside these ranges on
  // purpose — see the note in the report.
  const EMOJI_PRESENTATION = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{1FC00}-\u{1FFFD}\u{231A}-\u{231B}\u{23E9}-\u{23FA}\u{25FD}-\u{25FE}\u{2614}-\u{2615}\u{2648}-\u{2653}\u{267F}\u{2693}\u{26A1}\u{26AA}-\u{26AB}\u{26BD}-\u{26BE}\u{26C4}-\u{26C5}\u{26CE}\u{26D4}\u{26EA}\u{26F2}-\u{26F3}\u{26F5}\u{26FA}\u{26FD}\u{2705}\u{270A}-\u{270B}\u{2728}\u{274C}\u{274E}\u{2753}-\u{2755}\u{2757}\u{2795}-\u{2797}\u{27B0}\u{27BF}\u{2B1B}-\u{2B1C}\u{2B50}\u{2B55}\u{FE0F}\u{20E3}\u{3030}\u{303D}\u{3297}\u{3299}]/u;
  for (const [label, text] of [['markup', VISIBLE], ['inline script', VISIBLE_SCRIPT]]) {
    const hit = EMOJI_PRESENTATION.exec(text);
    assert.equal(hit, null, `emoji-presentation character in the ${label}: U+${hit && hit[0].codePointAt(0).toString(16).toUpperCase()}`);
  }
  // The status glyphs are still the plain-text ones.
  for (const glyph of ['\u25cf', '\u2715', '\u25d0', '\u25cc', '\u2713', '\u25cb']) {
    assert.ok(VISIBLE_SCRIPT.includes(glyph), `status glyph ${glyph} is gone`);
  }
});

test('no AI attribution leaks into the dashboard', () => {
  for (const needle of ['co-authored-by', 'generated by', 'generated-by', 'opencode', 'claude', 'chatgpt', 'copilot', 'gemini', 'gpt-', '\u{1F916}']) {
    assert.equal(
      TEMPLATE.toLowerCase().includes(needle), false,
      `AI attribution string in the dashboard: ${needle}`
    );
  }
});

// ============================================================ 5. accessibility

test('motion is respected in CSS and in script', () => {
  const reduced = [...STYLE.matchAll(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/g)];
  assert.ok(reduced.length >= 1, 'no prefers-reduced-motion media query');
  // The query must actually neutralise animation, not just exist.
  assert.match(REDUCED_BLOCK, /animation-duration:\s*\.001ms\s*!important/);
  assert.match(REDUCED_BLOCK, /transition-duration:\s*\.001ms\s*!important/);
  // The client script has to ask too, not just the stylesheet.
  assert.match(SCRIPT, /prefers-reduced-motion:\s*reduce/);
  assert.match(SCRIPT, /function reduced\s*\(\)/);
  // The moving packet down the pipe must stop moving.
  assert.match(REDUCED_BLOCK, /\.conduit\.live \.pkt\s*\{\s*animation:none/);
  assert.match(REDUCED_BLOCK, /button:hover:not\(:disabled\),\.tile:hover\s*\{\s*transform:none/);
});

test('a real copy is signalled by a lasting mark, never by motion alone', () => {
  // The 800ms tile flash is movement, so a "just copied" signal must also exist
  // in a non-moving form for anyone who asked for reduced motion.
  assert.match(SCRIPT, /' jn'/, 'the client must add a lasting just-now class to a tile');
  assert.match(VISIBLE_SCRIPT, /copied just now/, 'the lasting mark needs a text label, not just a colour');
  const jn = cssRules().filter((r) => /\.tile\.jn\b|\.t-note\.jn\b/.test(r.sel));
  assert.ok(jn.length >= 2, `expected a visible .jn style for tile and note, found ${jn.length}`);
  for (const r of jn) {
    assert.match(r.body, /box-shadow|border|color/, `the lasting mark is invisible: ${r.sel}{${r.body}}`);
  }
  // And under reduced motion the flash itself must be switched off.
  const flash = /\.tile\.flash\s*\{([^}]*)\}/.exec(REDUCED_BLOCK);
  assert.ok(flash, 'the reduced-motion block must deal with the tile flash');
  assert.doesNotMatch(flash[1], /--ok\)|color-mix\(in srgb,var\(--ok\)/, 'the flash still flashes under reduced motion');
});

test('keyboard focus is always visible', () => {
  const rules = cssRules().filter((r) => /:focus-visible/.test(r.sel));
  assert.ok(rules.length >= 1, 'no :focus-visible styles');
  assert.match(rules[0].body, /outline\s*:\s*[^;]*solid/, 'a focus ring needs a real outline');
  // The result panel is programmatically focused, so it must be reachable too.
  assert.match(MARKUP, /id="result"[^>]*tabindex="-1"/);
  assert.match(MARKUP, /<pre id="result-json" tabindex="0">/);
});

test('there is a live region, and the alert list is one', () => {
  const live = [...MARKUP.matchAll(/aria-live="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(live.length >= 1, 'no aria-live region');
  assert.ok(live.every((v) => v === 'polite' || v === 'assertive'), `bad aria-live value: ${live}`);
  // The two places that change on their own must announce themselves.
  const alerts = /<div class="alerts" id="alerts"[^>]*>/.exec(MARKUP);
  assert.ok(alerts && /aria-live="polite"/.test(alerts[0]), '#alerts must be a polite live region');
  const hero = /<div role="status" aria-live="polite">/.test(MARKUP);
  assert.ok(hero, 'the hero verdict must be announced');
  assert.match(MARKUP, /<p class="hero-t" id="hero-t">/);
  // Unchanged answers must not be re-announced on every 30s redraw.
  assert.match(SCRIPT, /if\s*\(key!==lastVerdict\)/);
  assert.match(SCRIPT, /if\s*\(html===lastAlertHtml\)return/);
});

test('the document declares its language', () => {
  const html = /<html\b[^>]*>/.exec(MARKUP);
  assert.ok(html, 'no <html> tag');
  const lang = /\blang="([^"]+)"/.exec(html[0]);
  assert.ok(lang, '<html> has no lang attribute');
  assert.match(lang[1], /^[a-z]{2}(-[A-Za-z0-9]+)*$/, `implausible lang value: ${lang[1]}`);
});

test('there is a skip link, and it points at a real target', () => {
  const anchors = [...MARKUP.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)]
    .map(([, attrs, text]) => ({ attrs, text: decode(text).trim() }))
    .filter((a) => /href="#/.test(a.attrs));
  const skip = anchors.find((a) => /^skip\b/i.test(a.text));
  assert.ok(skip, 'no skip-to-content link');
  const target = /href="#([^"]+)"/.exec(skip.attrs)[1];
  assert.ok(MARKUP_IDS.includes(target), `skip link points at a missing target: #${target}`);
  // It must be the first thing in the body, and hidden until focused.
  assert.match(MARKUP.slice(MARKUP.indexOf('<body>')), /<body>\s*<a\b[^>]*href="#/);
  assert.match(skip.attrs, /class="vh"/);
  assert.match(STYLE, /\.vh\s*\{[^}]*clip\s*:\s*rect\(/);
});

test('decorative marks are hidden from screen readers', () => {
  const icons = [...MARKUP.matchAll(/<(span|i)\b[^>]*\bclass="[^"]*(?:mark|sw|step-n|ck-t|hero-face)[^"]*"[^>]*>/g)];
  assert.ok(icons.length >= 3, 'expected decorative marks to guard');
  for (const m of icons) {
    assert.match(m[0], /aria-hidden="true"/, `decorative mark is announced: ${m[0]}`);
  }
  // Headings that are only for assistive tech must be visually hidden.
  assert.match(STYLE, /\.vh\s*\{/);
  assert.match(MARKUP, /<h2 class="vh"/);
});

test('the server first paint mirrors the client re-render', () => {
  // src/index.js says the client is the visual source of truth and that the
  // server's first paint mirrors it. If the two drift, the page visibly jumps
  // on the first refresh. Compare the two renderers side by side.
  const serverSide = SRC.slice(0, TEMPLATE_START);
  const groups = (region) => [...region.matchAll(/grp\(\s*'([^']+)'\s*,[\s\S]*?,\s*'([a-z]+)'\s*\)/g)].map((m) => [m[1], m[2]]);
  const serverGroups = groups(serverSide);
  const clientGroups = groups(SCRIPT);
  assert.ok(serverGroups.length >= 4, `expected the first-paint groups, found ${serverGroups.length}`);
  assert.deepEqual(
    clientGroups.slice(0, serverGroups.length), serverGroups,
    'the client re-render draws different groups from the server first paint'
  );
  // The retry group is client-only by design (the first paint cannot know it),
  // but it must still exist after the first refresh.
  assert.match(SCRIPT, /<div class="grp retry"><span class="grp-k">/, 'the client lost the retry group');
  // The same inner structure, so no tile reflows on the first refresh.
  const shape = (region) => [...region.matchAll(/class="(t-name|t-foot|t-count|t-unit|spark)"/g)].map((m) => m[1]);
  const first = [...new Set(shape(serverSide))];
  const second = [...new Set(shape(SCRIPT))];
  assert.ok(first.length >= 5, `expected the full tile skeleton, found ${first}`);
  assert.deepEqual(second.slice(0, first.length), first, 'the client tile skeleton differs from the first paint');
});

// ======================================================= 6. colour semantics

test('the retry/pending group uses a distinct lavender class, not warn/amber', () => {
  const retryRules = cssRules().filter((r) => /\.retry\b/.test(r.sel));
  assert.ok(retryRules.length >= 2, `expected .retry styles for group and tile, found ${retryRules.length}`);
  for (const r of retryRules) {
    assert.doesNotMatch(r.body, /--warn/, `retry style borrows the warn colour: ${r.sel}{${r.body}}`);
  }
  assert.ok(
    retryRules.some((r) => /--lav/.test(r.body)),
    'retry must be painted with the lavender token'
  );
  // The intent is written down in the stylesheet, so it is not a coincidence.
  assert.match(STYLE, /purple, not amber/i);
});

test('the retry group renders with the retry class and never the warn class', () => {
  const payload = healthyPayload({ pendingSinks: [{ to: 'team9@example.com', attempts: 2 }] });
  const { sandbox, node } = boot({ payload });
  sandbox.render(payload);
  const html = node('dests').innerHTML;
  assert.match(html, /class="grp retry"/, 'the queued-retry group must carry the retry class');
  assert.match(html, /class="tile retry"/, 'queued tiles must carry the retry class');
  assert.doesNotMatch(html, /\bwarn\b|\bmiss\b/, 'a queued retry must not be styled as "needs you"');
  assert.match(html, /Waiting for the next check/i);
  // The tile must say how many tries it has had, as a count and a unit.
  const tile = /<div class="tile retry"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/.exec(html);
  assert.ok(tile, 'no retry tile rendered');
  assert.match(tile[0], /class="t-count">2</, 'the retry tile must show the attempt count');
  assert.match(tile[0], /class="t-unit">tries</, 'the retry tile must label the count as tries');
  assert.match(html, /keeps them queued and retries on the next check/i);
});

test('warn and lavender stay visually distinct in both colour schemes', () => {
  // Only the blocks that actually declare the semantic palette count; a
  // responsive `:root` that just tweaks a spacing token is not a theme.
  const themes = [...STYLE.matchAll(/:root\s*\{([^}]*)\}/g)]
    .map((m) => m[1])
    .filter((decl) => decl.includes('--warn:') && decl.includes('--lav:'));
  assert.ok(themes.length >= 2, `expected dark and light palettes, found ${themes.length}`);
  for (const theme of themes) {
    const warn = /--warn:\s*(#[0-9a-fA-F]{3,8})/.exec(theme)[1];
    const lav = /--lav:\s*(#[0-9a-fA-F]{3,8})/.exec(theme)[1];
    assert.notEqual(warn.toLowerCase(), lav.toLowerCase(), 'warn and lavender collapsed to the same colour');
  }
});

test('the colour key keeps amber for "needs you" and purple for "queued"', () => {
  // Robust: this reads the *meaning* attached to each swatch wherever the key
  // appears (the pipe legend and the guide legend) instead of pinning markup,
  // so the wording can change but the meaning cannot drift.
  const meaning = (swatch) => {
    const found = [];
    for (const m of MARKUP.matchAll(new RegExp(`class="sw sw-${swatch}"`, 'g'))) {
      const window = decode(MARKUP.slice(m.index + m[0].length, m.index + m[0].length + 240).replace(/<[^>]*>/g, ' '));
      const afterDash = window.split(/[—–]/)[1];
      found.push((afterDash ?? window).split(/[.;:]/)[0].trim());
    }
    return found;
  };
  for (const text of meaning('lav')) {
    assert.match(text, /queued|trying again|retry/i, `purple means: ${text}`);
    assert.doesNotMatch(text, /needs you|no sign-in details/i, `purple must not mean "needs you": ${text}`);
  }
  for (const text of meaning('warn')) {
    assert.match(text, /needs you|no sign-in details/i, `amber means: ${text}`);
    assert.doesNotMatch(text, /queued|trying again|retry/i, `amber must not mean "queued": ${text}`);
  }
  assert.ok(meaning('lav').length >= 2, 'purple must be in the key and in the guide');
  assert.ok(meaning('warn').length >= 2, 'amber must be in the key and in the guide');
});
