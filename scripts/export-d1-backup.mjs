#!/usr/bin/env node
// Export the D1 `seen` dedupe table to ONE deterministic JSON file.
//
// Dependency-free on purpose: this runs on a bare Node 20 CI runner with no
// `npm install`, using only global fetch. It is a read-only SELECT loop — it
// never writes to the database.
//
//   node scripts/export-d1-backup.mjs
//   node scripts/export-d1-backup.mjs --out /tmp/sinka-seen.json
//   node scripts/export-d1-backup.mjs --dry-run
//   node scripts/export-d1-backup.mjs --page-size 500
//
// Configuration comes from the PROCESS ENVIRONMENT only:
//   CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, CLOUDFLARE_API_TOKEN
// This script never reads .env, never calls dotenv, and has no id or token
// baked into it. For a local run let the shell supply them, e.g.
//   node --env-file=.env scripts/export-d1-backup.mjs --dry-run
//
// Output rows are `{ id, seen_at }` (see schema.sql), always in that key
// order, ordered by seen_at then id, pretty-printed with 2-space indent and a
// trailing newline — so two runs over an unchanged table are byte-identical.
//
// Exit codes: 0 ok · 1 bad usage/config · 2 D1 API error · 3 write error.

import fs from 'node:fs';
import path from 'node:path';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const DEFAULT_PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 10000;
const REDACTED = '***REDACTED***';

class ExportError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Redaction
//
// Everything printed goes through scrubSecrets(); anything that came back from
// the network also goes through scrubOpaque(). The token itself is in the
// known-values list, so it can never be printed even if an error echoes the
// request we sent. The rest is belt-and-braces for shapes we do not control.
// ---------------------------------------------------------------------------

const KNOWN_SECRETS = [
  process.env.CLOUDFLARE_API_TOKEN,
  process.env.D1_EXPORT_TOKEN,
]
  .map((v) => String(v ?? '').trim())
  .filter((v) => v.length >= 8);

function scrubSecrets(text) {
  let out = String(text ?? '');
  for (const secret of KNOWN_SECRETS) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  // `Authorization: Bearer <x>` / `token=<x>` in any dumped headers or URL.
  out = out.replace(/\b(bearer|token|authorization|api[_-]?key)\b\s*[:=]?\s*[^\s"',;)}\]]+/gi, (m) => {
    const label = m.match(/^[^:=\s]+/)[0];
    return `${label}=${REDACTED}`;
  });
  return out;
}

function scrubOpaque(text) {
  // Cloudflare API tokens are 40 base62/url-safe chars. Any long opaque run is
  // redacted so a differently shaped secret still cannot leak.
  return scrubSecrets(text).replace(/[A-Za-z0-9_-]{40,}/g, REDACTED);
}

function say(line = '') {
  process.stdout.write(`${scrubSecrets(line)}\n`);
}

function warn(line) {
  process.stderr.write(`${scrubOpaque(line)}\n`);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function usage() {
  return [
    'Usage: node scripts/export-d1-backup.mjs [options]',
    '',
    '  --out <path>       Where to write the JSON',
    '                     (default: backups/sinka-seen-<UTC timestamp>.json)',
    `  --page-size <n>    Rows per query, ${DEFAULT_PAGE_SIZE} by default (max ${MAX_PAGE_SIZE})`,
    '  --dry-run          Query and count only, write nothing',
    '  -h, --help         This text',
    '',
    'Required environment: CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, CLOUDFLARE_API_TOKEN',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { out: null, pageSize: DEFAULT_PAGE_SIZE, dryRun: false };
  let i = 0;
  const next = (flag) => {
    const value = argv[i++];
    if (value === undefined) throw new ExportError(`${flag} needs a value`, 1);
    return value;
  };
  while (i < argv.length) {
    const arg = argv[i++];
    switch (arg) {
      case '--out':
      case '-o':
        opts.out = next(arg);
        break;
      case '--page-size':
        opts.pageSize = Number.parseInt(next(arg), 10);
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '-h':
      case '--help':
        say(usage());
        process.exit(0);
        break;
      default:
        throw new ExportError(`unknown argument: ${arg}\n\n${usage()}`, 1);
    }
  }
  if (!Number.isInteger(opts.pageSize) || opts.pageSize < 1 || opts.pageSize > MAX_PAGE_SIZE) {
    throw new ExportError(`--page-size must be an integer 1..${MAX_PAGE_SIZE}`, 1);
  }
  return opts;
}

function readConfig() {
  const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
  const databaseId = String(process.env.D1_DATABASE_ID ?? '').trim();
  const token = String(process.env.CLOUDFLARE_API_TOKEN ?? '').trim();
  const missing = [];
  if (!accountId) missing.push('CLOUDFLARE_ACCOUNT_ID');
  if (!databaseId) missing.push('D1_DATABASE_ID');
  if (!token) missing.push('CLOUDFLARE_API_TOKEN');
  if (missing.length) {
    throw new ExportError(
      `missing environment: ${missing.join(', ')}\n` +
        'Export these into the environment yourself; this script does not read .env.\n' +
        'Locally: node --env-file=.env scripts/export-d1-backup.mjs',
      1
    );
  }
  // The ids go into a URL path: refuse anything that is not a plain id.
  for (const [name, value] of [
    ['CLOUDFLARE_ACCOUNT_ID', accountId],
    ['D1_DATABASE_ID', databaseId],
  ]) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
      throw new ExportError(`${name} is not a valid id (got ${value.length} chars)`, 1);
    }
  }
  return { accountId, databaseId, token };
}

// ---------------------------------------------------------------------------
// D1 read path (same endpoint and body shape as src/store_d1.js)
// ---------------------------------------------------------------------------

async function d1Query({ accountId, databaseId, token, sql, params }) {
  const url = `${API_BASE}/accounts/${accountId}/d1/database/${databaseId}/query`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    });
  } catch (err) {
    throw new ExportError(
      `could not reach the D1 query API: ${err?.message || String(err)}`,
      2
    );
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null; // not JSON; the raw text below is the only diagnostic left
  }

  const detail = (payload) => {
    const errors = payload?.errors;
    if (Array.isArray(errors) && errors.length) {
      return errors
        .map((e) => `${e?.code ? `${e.code}:` : ''}${e?.message || JSON.stringify(e)}`)
        .join('; ')
        .slice(0, 400);
    }
    return scrubOpaque(text).slice(0, 400) || '(empty response body)';
  };

  if (!res.ok) {
    throw new ExportError(
      `D1 query API returned HTTP ${res.status} ${res.statusText || ''}`.trim() +
        ` — ${detail(data)}`,
      2
    );
  }
  if (!data || data.success !== true) {
    throw new ExportError(`D1 query API reported success=false — ${detail(data)}`, 2);
  }
  const rows = data.result?.[0]?.results;
  if (!Array.isArray(rows)) {
    throw new ExportError('D1 query API response had no result rows array', 2);
  }
  return rows;
}

// `seen_at` alone is not unique (same-millisecond inserts), so id breaks ties.
// Without it, LIMIT/OFFSET paging could repeat or skip a row at a page edge.
const SELECT_PAGE = 'SELECT id, seen_at FROM seen ORDER BY seen_at ASC, id ASC LIMIT ? OFFSET ?';

function normalizeRow(row) {
  return {
    id: row?.id == null ? null : String(row.id),
    seen_at: row?.seen_at == null ? null : String(row.seen_at),
  };
}

async function exportRows({ accountId, databaseId, token, pageSize }) {
  const rows = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    const page = await d1Query({
      accountId,
      databaseId,
      token,
      sql: SELECT_PAGE,
      params: [pageSize, offset],
    });
    pages += 1;
    for (const row of page) rows.push(normalizeRow(row));
    if (page.length < pageSize) break; // last page
    offset += pageSize;
  }
  return { rows, pages };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function defaultOutPath() {
  // UTC, filesystem-safe, sorts chronologically: 20260926T042300Z
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return path.join('backups', `sinka-seen-${stamp}.json`);
}

function writeBackup(outPath, text) {
  const dir = path.dirname(path.resolve(outPath));
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Write to a sibling temp file and rename, so a partial write can never be
    // mistaken for a good backup. 0600: the file holds mail Message-IDs.
    const tmp = path.join(dir, `.${path.basename(outPath)}.tmp`);
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, outPath);
    fs.chmodSync(outPath, 0o600);
  } catch (err) {
    throw new ExportError(`could not write ${outPath}: ${err?.message || String(err)}`, 3);
  }
}

function formatBytes(n) {
  return `${n.toLocaleString('en-US')} bytes`;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    warn(`error: ${err.message}`);
    return err.code;
  }

  let config;
  try {
    config = readConfig();
  } catch (err) {
    warn(`error: ${err.message}`);
    return err.code;
  }

  const outPath = opts.out || defaultOutPath();

  say('sinka d1 backup — seen table');
  // Ids stay out of the log: this repo keeps account/database ids out of git
  // on purpose (see wrangler.toml), so a backup run must not leak them either.
  say('  target:  d1 `seen` via the query API (account/database id not printed)');

  let rows;
  let pages;
  try {
    ({ rows, pages } = await exportRows({ ...config, pageSize: opts.pageSize }));
  } catch (err) {
    warn(`error: ${err.message}`);
    return err.code;
  }

  // An empty table is a valid backup, not a failure: it serialises to `[]`.
  const text = `${JSON.stringify(rows, null, 2)}\n`;
  const bytes = Buffer.byteLength(text, 'utf8');
  const withoutId = rows.filter((r) => r.id === null).length;

  say(`  pages:   ${pages} (page size ${opts.pageSize})`);
  say(`  rows:    ${rows.length}`);
  if (rows.length) {
    say(`  range:   ${rows[0].seen_at}  ->  ${rows[rows.length - 1].seen_at}`);
  } else {
    say('  range:   (table is empty)');
  }
  if (withoutId) say(`  warning: ${withoutId} row(s) have a NULL id`);

  if (opts.dryRun) {
    say(`  would write ${formatBytes(bytes)} to ${outPath}`);
    say('dry run: nothing was written');
    return 0;
  }

  try {
    writeBackup(outPath, text);
  } catch (err) {
    warn(`error: ${err.message}`);
    return err.code;
  }

  say(`  out:     ${path.resolve(outPath)}`);
  say(`  bytes:   ${formatBytes(bytes)}`);
  return 0;
}

const code = await main();
process.exit(code);
