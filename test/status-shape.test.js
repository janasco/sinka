import test from 'node:test';
import assert from 'node:assert/strict';

// Pure helpers only — never imports src/index.js (it would start a server).
const { loadConfig, isAutoNotice, parseSinks } = await import('../src/mail.js');

function headers(obj) {
  return { get: (name) => obj[name.toLowerCase()] ?? '' };
}

test('loadConfig parses explicit env without touching process.env', () => {
  const cfg = loadConfig({
    GMAIL_USER: 'you@example.com',
    GMAIL_APP_PASSWORD: 'secret',
    FORWARD_LIST: 'a@x.com, b@x.com',
    DEST_SINKS: 'a@x.com:pa;b@x.com:pb',
    POLL_INTERVAL_MS: '1234',
    LOOKBACK_HOURS: '5',
    PORT: '9999',
    DATA_DIR: './data',
    ADMIN_TOKEN: 'tok',
    DRY_RUN: '1',
  });
  assert.equal(cfg.gmailUser, 'you@example.com');
  assert.deepEqual(cfg.forwardList, ['a@x.com', 'b@x.com']);
  assert.deepEqual(cfg.sinks, parseSinks('a@x.com:pa;b@x.com:pb'));
  assert.equal(cfg.pollIntervalMs, 1234);
  assert.equal(cfg.lookbackHours, 5);
  assert.equal(cfg.port, 9999);
  assert.equal(cfg.dryRun, true);
});

test('loadConfig throws with a clear message when credentials are missing', () => {
  assert.throws(() => loadConfig({ GMAIL_APP_PASSWORD: 'x' }), /GMAIL_USER/);
  assert.throws(() => loadConfig({ GMAIL_USER: 'you@example.com' }), /GMAIL_APP_PASSWORD/);
});

test('loadConfig sinks shape matches parseSinks entries', () => {
  const cfg = loadConfig({
    GMAIL_USER: 'you@example.com',
    GMAIL_APP_PASSWORD: 'secret',
    DEST_SINKS: 'a@x.com:pa;-b@x.com:pb',
  });
  assert.deepEqual(cfg.sinks, [
    { user: 'a@x.com', pass: 'pa', enabled: true },
    { user: 'b@x.com', pass: 'pb', enabled: false },
  ]);
});

test('isAutoNotice: normal mail is not an auto-notice', () => {
  const parsed = { headers: headers({}), from: { text: 'alice@example.com' } };
  assert.equal(isAutoNotice(parsed, 'From: alice@example.com\r\n\r\nhello'), false);
});

test('isAutoNotice: Auto-Submitted header marks system mail', () => {
  const parsed = { headers: headers({ 'auto-submitted': 'auto-replied' }), from: { text: 'x@y.z' } };
  assert.equal(isAutoNotice(parsed, 'hello'), true);
});

test('isAutoNotice: mailer-daemon / postmaster senders are skipped', () => {
  const daemon = { headers: headers({}), from: { text: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' } };
  assert.equal(isAutoNotice(daemon, 'hello'), true);
  const postmaster = { headers: headers({}), from: { text: 'postmaster@example.com' } };
  assert.equal(isAutoNotice(postmaster, 'hello'), true);
});

test('isAutoNotice: delivery-status reports and null return-path are skipped', () => {
  const report = {
    headers: headers({ 'content-type': 'multipart/report; report-type=delivery-status' }),
    from: { text: 'x@y.z' },
  };
  assert.equal(isAutoNotice(report, 'hello'), true);
  const nullPath = { headers: headers({}), from: { text: 'x@y.z' } };
  assert.equal(isAutoNotice(nullPath, 'Return-Path: <>\r\nFrom: x@y.z\r\n\r\nbounced'), true);
});
