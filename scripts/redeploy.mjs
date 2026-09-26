#!/usr/bin/env node
// Safe recreate cycle for the singleton replicator container.
//
// Why this exists: the container reads its settings when it is created, so a
// new Worker secret or a wrangler.toml change stays invisible until the
// application is recreated. Doing that by hand (find the id, delete it,
// deploy again) is easy to get wrong — delete the wrong application and you
// have taken out something else entirely. This script does the whole cycle in
// the only safe order, resolves the target by name and refuses to guess:
//
//   0. read-only preflight: exactly one app named <CONTAINER_APP> must exist
//   1. npx wrangler deploy   — upload the new build and the new env
//   2. resolve the container application id again (authoritative)
//   3. DELETE that one application — the poller is down for ~1-2 min
//   4. npx wrangler deploy   — a fresh application comes up with the new env
//   5. verify: re-resolve by name and poll for a running instance
//
// Secrets must already be set (`wrangler secret put ...`) before this runs;
// recreating with stale secrets just brings the old behaviour back.
//
// Flags: --dry-run  print the plan, change nothing (still resolves, read-only)
//        --yes      skip the confirmation prompt
//        --timeout-ms <n>  how long to wait for the new instance (default 180000)
//
// No dependencies: global fetch and node: builtins only. `npm run redeploy`.
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

// Application name is derived by wrangler from worker + class name, so this is
// the only name this script is ever allowed to touch.
export const CONTAINER_APP = 'sinka-replicatorcontainer';
const DEPLOY_CMD = 'npx wrangler deploy';
const API_ROOT = 'https://api.cloudflare.com/client/v4';
const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 5_000;

// --- pure helpers (exported for test/redeploy.test.js) ---

// Nothing that could carry a credential reaches the log verbatim: the known
// token, any Authorization header, any token-ish key/value pair, and any bare
// opaque string long enough to be a real credential.
export function redact(text, secret = '') {
  let out = String(text ?? '');
  if (secret) out = out.split(secret).join('[REDACTED]');
  out = out.replace(/(Bearer\s+)[^\s"',}]+/gi, '$1[REDACTED]');
  out = out.replace(
    /("?(?:api_?token|token|authorization|secret|password|passwd|app_?password)"?\s*[:=]\s*"?(?:Bearer\s+|Basic\s+|Token\s+)?)([^"\s,}]+)/gi,
    '$1[REDACTED]'
  );
  // A Cloudflare API token is 40 chars of [A-Za-z0-9_-]; the 40+ floor keeps
  // container uuids and account ids readable.
  out = out.replace(/[A-Za-z0-9_-]{40,}/g, '[REDACTED]');
  return out;
}

export function parseArgs(argv) {
  const args = { dryRun: false, yes: false, timeoutMs: DEFAULT_TIMEOUT_MS, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--yes' || arg === '-y') args.yes = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--timeout-ms') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`--timeout-ms needs a positive number of milliseconds, got ${argv[i]}`);
      }
      args.timeoutMs = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

// Name match is the only selection rule. Anything other than exactly one hit is
// an abort, never a guess — an account can hold unrelated applications.
export function selectAppByName(apps, name = CONTAINER_APP) {
  const list = Array.isArray(apps) ? apps : [];
  const matches = list.filter((app) => app && app.name === name);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    const known = list.map((app) => app?.name).filter(Boolean);
    const seen = known.length ? known.join(', ') : 'none';
    throw new Error(
      `No container application named "${name}" in this account. Nothing was touched. ` +
      `Applications in this account: ${seen}.`
    );
  }
  throw new Error(
    `${matches.length} applications are named "${name}" (${matches
      .map((app) => app.id)
      .join(', ')}). Refusing to guess which one to delete — nothing was touched.`
  );
}

// Health is nested and optional; every field has to survive an absent key.
export function summarizeHealth(app) {
  const instances = app?.health?.instances ?? {};
  return {
    active: Number(instances.active ?? 0),
    starting: Number(instances.starting ?? 0),
    scheduling: Number(instances.scheduling ?? 0),
    failed: Number(instances.failed ?? 0),
    stopped: Number(instances.stopped ?? 0),
  };
}

export function isRunning(app) {
  return summarizeHealth(app).active > 0;
}

export function formatSeconds(ms) {
  return `${Math.round(ms / 1000)}s`;
}

// Padded so the detail column lines up however long the labels get.
const LABEL_WIDTH = 27;
const pad = (label) => label.padEnd(LABEL_WIDTH);
const GAP = ' '.repeat(LABEL_WIDTH);

export function buildPlan({ appId = null, appName = CONTAINER_APP, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const target = appId ? `${appName} (id ${appId})` : `${appName} (id not resolved yet)`;
  return [
    `${pad('1. deploy the worker')}${DEPLOY_CMD}`,
    `${GAP}(uploads the new build and the env you already set)`,
    `${pad('2. resolve container app')}name "${appName}" -> exactly one id, abort if 0 or >1`,
    `${pad('3. delete that application')}DELETE /accounts/.../containers/applications/${appId ?? '<resolved-id>'}`,
    `${GAP}this is ${target}; the poller stops for ~1-2 min`,
    `${pad('4. deploy the worker again')}${DEPLOY_CMD}`,
    `${GAP}(a fresh container is created with the new env)`,
    `${pad('5. verify')}re-resolve by name, poll up to ${formatSeconds(timeoutMs)} for "running"`,
  ];
}

// Turn any HTTP failure into a message that is safe to print.
export function describeApiError(status, body, secret = '') {
  const raw = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  const text = redact(raw, secret).trim();
  return `Cloudflare API returned HTTP ${status}${text ? `: ${text}` : ''}`;
}

// --- Cloudflare API (read-only except the single delete) ---

async function apiRequest(path, { token, method = 'GET', body, timeoutMs = 30_000 } = {}) {
  let response;
  try {
    response = await fetch(`${API_ROOT}/accounts/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`Cloudflare API request failed: ${redact(err.message, token)}`);
  }
  const text = await response.text();
  if (!response.ok) throw new Error(describeApiError(response.status, text, token));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Cloudflare API returned a non-JSON body (HTTP ${response.status})`);
  }
}

// GET /accounts/:id/containers/applications — the list, not a name filter, so
// a duplicate name stays visible to selectAppByName.
export async function listApplications({ token, accountId }) {
  const payload = await apiRequest(`${accountId}/containers/applications`, { token });
  return Array.isArray(payload?.result) ? payload.result : [];
}

export async function deleteApplication({ token, accountId, applicationId }) {
  await apiRequest(`${accountId}/containers/applications/${encodeURIComponent(applicationId)}`, {
    token,
    method: 'DELETE',
  });
}

async function resolveContainerApp(ctx) {
  return selectAppByName(await listApplications(ctx), CONTAINER_APP);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bounded twice over: the deadline is checked before every sleep, and the
// attempt count is capped too, so this returns even if the clock misbehaves.
// A single hung request cannot outlast it either (see apiRequest timeout).
export async function waitForRunning({ ctx, timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS, now = Date.now }) {
  const deadline = now() + timeoutMs;
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  let last = null;
  for (let attempts = 1; attempts <= maxAttempts; attempts++) {
    last = await resolveContainerApp(ctx);
    if (isRunning(last)) return { ok: true, app: last, attempts };
    if (now() >= deadline) return { ok: false, app: last, attempts, state: describeState(last) };
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  return { ok: false, app: last, attempts: maxAttempts, state: describeState(last) };
}

export function describeState(app) {
  if (!app) return 'unavailable (the application could not be read)';
  const h = summarizeHealth(app);
  if (h.active > 0) return `running (${h.active} active instance)`;
  if (h.failed > 0) return `stopped (${h.failed} instance(s) failed to start)`;
  if (h.stopped > 0) return `stopped (${h.stopped} stopped instance(s))`;
  return `stopped (starting ${h.starting}, scheduling ${h.scheduling}, active 0)`;
}

function runWranglerDeploy() {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['wrangler', 'deploy'], { stdio: 'inherit' });
    child.on('error', (err) => reject(new Error(`Could not run npx wrangler deploy: ${err.message}`)));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${DEPLOY_CMD} failed with exit code ${code}`))
    );
  });
}

// Answer must be an exact word: a blank line, EOF, a closed stream or a
// non-terminal stdin all read as "no". Only --yes overrides this.
async function confirm(question) {
  if (!process.stdin.isTTY) return '';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return String(answer ?? '').trim();
  } catch {
    return '';
  } finally {
    rl.close();
  }
}

const USAGE = `Usage: node scripts/redeploy.mjs [options]

Recreates the singleton container so a new Worker secret or wrangler.toml
change actually takes effect. Secrets must already be set.

  --dry-run         print the plan, change nothing (still resolves, read-only)
  --yes, -y         skip the confirmation before the delete
  --timeout-ms <n>  how long to wait for the new instance (default ${DEFAULT_TIMEOUT_MS})
  --help, -h        this text
`;

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  // The token itself is never printed; only whether it is present.
  const token = process.env.CLOUDFLARE_API_TOKEN || '';
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  const missing = [];
  if (!token) missing.push('CLOUDFLARE_API_TOKEN');
  if (!accountId) missing.push('CLOUDFLARE_ACCOUNT_ID');
  if (missing.length) {
    console.error(`Missing ${missing.join(' and ')} in the environment (or in .env). Nothing was touched.`);
    return 1;
  }
  const ctx = { token, accountId };

  // After the delete, a failure leaves no container at all — say how to get one
  // back instead of leaving the operator to work that out during an outage.
  const fail = (message, { afterDelete = false } = {}) => {
    console.error(redact(message, token));
    if (afterDelete) {
      console.error('The container application is gone. Bring it back with: npm run redeploy');
    }
    return 1;
  };

  let app;
  try {
    app = await resolveContainerApp(ctx);
  } catch (err) {
    return fail(err.message);
  }

  console.log('Plan:');
  for (const line of buildPlan({ appId: app.id, timeoutMs: args.timeoutMs })) console.log('  ' + line);
  console.log('');

  if (args.dryRun) {
    console.log(`Dry run. Resolved "${CONTAINER_APP}" -> id ${app.id}.`);
    console.log(`Current state: ${describeState(app)}.`);
    console.log('Nothing was deployed, deleted or created.');
    return 0;
  }

  if (!args.yes) {
    const answer = await confirm(
      `This deletes container application ${app.id} and stops the poller for ~1-2 min. Type "recreate" to continue: `
    );
    if (answer !== 'recreate') {
      console.log(
        answer
          ? 'Aborted (nothing was changed). Only the exact word "recreate" proceeds.'
          : 'Aborted (nothing was changed): no confirmation was given. Re-run with --yes if you are sure.'
      );
      return 1;
    }
  }

  // 1. Upload the new build and env before the application is recreated.
  console.log('\n[1/4] Deploying the worker (new build + env)...');
  try {
    await runWranglerDeploy();
  } catch (err) {
    return fail(err.message);
  }

  // 2. Re-resolve: the deploy above is authoritative, and a wrong id is still
  //    a hard abort rather than a delete of whatever happened to be there.
  try {
    app = await resolveContainerApp(ctx);
  } catch (err) {
    return fail(err.message);
  }

  // 3. Destroy the one application that matches by name.
  console.log(`\n[2/4] Deleting container application ${app.id} (${CONTAINER_APP})...`);
  try {
    await deleteApplication({ ...ctx, applicationId: app.id });
  } catch (err) {
    return fail(err.message);
  }
  console.log('       deleted. The poller is down for ~1-2 min.');

  // 4. Deploy again so a fresh application is created with the new env.
  console.log('\n[3/4] Deploying again so a fresh container is created...');
  try {
    await runWranglerDeploy();
  } catch (err) {
    return fail(err.message, { afterDelete: true });
  }

  // 5. Bounded verification. The new application has a new id, so this waits
  //    by name rather than on the deleted one.
  console.log(`\n[4/4] Waiting up to ${formatSeconds(args.timeoutMs)} for the new container...`);
  let result;
  try {
    result = await waitForRunning({ ctx, timeoutMs: args.timeoutMs });
  } catch (err) {
    return fail(err.message, { afterDelete: true });
  }

  console.log('');
  if (result.ok) {
    console.log(`Container is running (id ${result.app.id}).`);
  } else {
    console.error(`Container is NOT running: ${result.state}.`);
    console.error('Check `npx wrangler containers list` and the Worker logs.');
    return 1;
  }
  console.log('What this proves: the process started and the worker port answers.');
  console.log('What it does not prove: the container is healthy at the Gmail level.');
  console.log('Check /api/status (sinksConfigured, seenCount) and let one poll cycle run.');
  return 0;
}

// Only run when invoked directly, so the helpers can be imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
