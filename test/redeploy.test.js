// Unit tests for the redeploy helper. No network, no secrets, no wrangler:
// every case below feeds the exported pure helpers fixed data.
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  CONTAINER_APP,
  redact,
  parseArgs,
  selectAppByName,
  summarizeHealth,
  isRunning,
  describeState,
  buildPlan,
  describeApiError,
  formatSeconds,
  waitForRunning,
} = await import('../scripts/redeploy.mjs');

const app = (over = {}) => ({ id: 'app-id-1', name: CONTAINER_APP, health: { instances: {} }, ...over });

test('selectAppByName() picks the single exact name match', () => {
  const target = app({ id: 'aaa' });
  const picked = selectAppByName([app({ id: 'other', name: 'unrelated-app' }), target], CONTAINER_APP);
  assert.equal(picked.id, 'aaa');
});

test('selectAppByName() does not match on a prefix or different case', () => {
  const list = [app({ name: 'sinka-replicatorcontainer-old' }), app({ name: 'SINKA-ReplicatorContainer' })];
  assert.throws(() => selectAppByName(list, CONTAINER_APP), /No container application named/);
});

test('selectAppByName() aborts on zero matches and says nothing was touched', () => {
  assert.throws(
    () => selectAppByName([app({ name: 'other' })], CONTAINER_APP),
    (err) => /No container application named "sinka-replicatorcontainer"/.test(err.message) && /Nothing was touched/.test(err.message)
  );
  assert.throws(() => selectAppByName([], CONTAINER_APP), /Applications in this account: none/);
  assert.throws(() => selectAppByName(null, CONTAINER_APP), /No container application named/);
});

test('selectAppByName() aborts on duplicate names instead of guessing', () => {
  const list = [app({ id: 'dup-1' }), app({ id: 'dup-2' })];
  assert.throws(
    () => selectAppByName(list, CONTAINER_APP),
    (err) =>
      /2 applications are named/.test(err.message) &&
      /dup-1, dup-2/.test(err.message) &&
      /Refusing to guess/.test(err.message) &&
      /nothing was touched/.test(err.message)
  );
});

test('summarizeHealth() defaults every field when health is absent', () => {
  assert.deepEqual(summarizeHealth({}), { active: 0, starting: 0, scheduling: 0, failed: 0, stopped: 0 });
  assert.deepEqual(summarizeHealth(null), { active: 0, starting: 0, scheduling: 0, failed: 0, stopped: 0 });
  assert.equal(summarizeHealth({ health: { instances: { active: 2 } } }).active, 2);
});

test('isRunning() only counts an active instance', () => {
  assert.equal(isRunning(app({ health: { instances: { active: 1 } } })), true);
  assert.equal(isRunning(app({ health: { instances: { active: 0, starting: 1 } } })), false);
  assert.equal(isRunning(app({ health: { instances: { active: 0, failed: 1 } } })), false);
  assert.equal(isRunning(app()), false);
});

test('describeState() reports running, stopped and unavailable', () => {
  assert.match(describeState(app({ health: { instances: { active: 1 } } })), /^running \(1 active instance\)$/);
  assert.match(describeState(app({ health: { instances: { failed: 1 } } })), /^stopped \(1 instance\(s\) failed/);
  assert.match(describeState(app({ health: { instances: { stopped: 2 } } })), /^stopped \(2 stopped/);
  assert.match(describeState(app({ health: { instances: { starting: 1, scheduling: 1 } } })), /^stopped \(starting 1, scheduling 1/);
  assert.match(describeState(null), /unavailable/);
});

test('redact() removes the known token, bearer headers and token fields', () => {
  const token = 'abcdefghij0123456789ABCDEFGHIJ0123456789';
  assert.equal(redact(`Authorization: Bearer ${token}`, token), 'Authorization: Bearer [REDACTED]');
  assert.equal(redact(`token leaked ${token} here`, token), 'token leaked [REDACTED] here');
  assert.equal(redact('{"api_token":"v1.0-zzzZZZ-secret"}'), '{"api_token":"[REDACTED]"}');
  assert.equal(redact('api_token = v1.0-zzzZZZ-secret'), 'api_token = [REDACTED]');
  assert.equal(redact('GMAIL_APP_PASSWORD: hunter2hunter2'), 'GMAIL_APP_PASSWORD: [REDACTED]');
  assert.equal(redact('Authorization: Bearer short'), 'Authorization: Bearer [REDACTED]');
  // The body must stay readable JSON, not a truncated one.
  assert.equal(redact('{"authorization":"Bearer abcdefghijklmnop"}'), '{"authorization":"Bearer [REDACTED]"}');
  assert.equal(
    redact('{"errors":[{"code":10000,"message":"Authentication error"}]}'),
    '{"errors":[{"code":10000,"message":"Authentication error"}]}'
  );
});

test('redact() blanks bare long tokens but keeps readable ids and names', () => {
  assert.equal(redact('token=' + 'A'.repeat(40)), 'token=[REDACTED]');
  assert.equal(redact('id a0313bbe-c7da-411e-b5e0-d37db2b61bc6'), 'id a0313bbe-c7da-411e-b5e0-d37db2b61bc6');
  assert.equal(redact('account 9c686ab673caa0f69af5bee930392670'), 'account 9c686ab673caa0f69af5bee930392670');
  assert.equal(redact('name ' + CONTAINER_APP), 'name ' + CONTAINER_APP);
});

test('redact() never leaks a token through a longer secret value', () => {
  const token = 'x'.repeat(40);
  assert.ok(!redact(`{"errors":[{"message":"${token}"}]}`, token).includes(token));
});

test('parseArgs() defaults to interactive-safe and understands the flags', () => {
  const base = parseArgs([]);
  assert.equal(base.dryRun, false, 'no --dry-run means a real run');
  assert.equal(base.yes, false, 'no --yes means the delete is confirmed first');
  assert.equal(base.timeoutMs, 180_000);
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
  assert.equal(parseArgs(['--yes', '--dry-run']).yes, true);
  assert.equal(parseArgs(['-y']).yes, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['--timeout-ms', '5000']).timeoutMs, 5000);
  assert.throws(() => parseArgs(['--timeout-ms', 'soon']), /positive number/);
  assert.throws(() => parseArgs(['--timeout-ms']), /positive number/);
  assert.throws(() => parseArgs(['--nope']), /Unknown argument: --nope/);
});

test('buildPlan() names the resolved id and keeps the order deploy, delete, deploy', () => {
  const plan = buildPlan({ appId: 'app-123', timeoutMs: 180_000 }).join('\n');
  assert.match(plan, /sinka-replicatorcontainer \(id app-123\)/);
  assert.match(plan, /applications\/app-123/);
  assert.match(plan, /180s/);
  const first = plan.indexOf('1. deploy the worker');
  const del = plan.indexOf('3. delete that application');
  const again = plan.indexOf('4. deploy the worker again');
  assert.ok(first > -1 && del > first && again > del, 'delete happens between the two deploys');
  // The unresolved form must never print a fake id.
  assert.match(buildPlan({}).join('\n'), /<resolved-id>/);
});

test('describeApiError() redacts an error body that echoes a token', () => {
  const token = 'q'.repeat(40);
  const msg = describeApiError(401, JSON.stringify({ errors: [{ message: `bad token ${token}` }] }), token);
  assert.match(msg, /Cloudflare API returned HTTP 401/);
  assert.ok(!msg.includes(token));
  assert.match(msg, /\[REDACTED\]/);
  assert.match(describeApiError(500, ''), /Cloudflare API returned HTTP 500$/);
});

test('formatSeconds() is readable', () => {
  assert.equal(formatSeconds(180_000), '180s');
  assert.equal(formatSeconds(5_000), '5s');
});

// fetch is stubbed, so this stays offline and secret-free. The point of the
// test is the bound: a container that never comes up must return, not hang.
test('waitForRunning() returns when the new application never reports running', async () => {
  const started = Date.now();
  const stuck = app({ id: 'new-id', health: { instances: { active: 0, starting: 1 } } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ success: true, result: [stuck] }),
  });
  try {
    const result = await waitForRunning({
      ctx: { token: 'unused', accountId: 'unused' },
      timeoutMs: 30,
      intervalMs: 5,
      now: () => Date.now() - started,
    });
    assert.equal(result.ok, false);
    assert.equal(result.app.id, 'new-id', 'it resolved the current application, not a deleted id');
    assert.match(result.state, /^stopped \(starting 1/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
