import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import fs from 'node:fs';
import path from 'node:path';

// Build configs from env. Throws with a clear message if credentials missing.
export function loadConfig(env = process.env) {
  const gmailUser = (env.GMAIL_USER || '').trim();
  const appPassword = (env.GMAIL_APP_PASSWORD || '').trim();
  if (!gmailUser) throw new Error('GMAIL_USER is not set (copy .env.example to .env)');
  if (!appPassword) throw new Error('GMAIL_APP_PASSWORD is not set (use a Gmail App Password, not your login password)');

  const forwardList = (env.FORWARD_LIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Delivery is always IMAP APPEND: raw bytes are copied straight into each
  // destination mailbox (Thunderbird-style, no sending at all, no send caps).
  // DEST_SINKS="user1@gmail.com:apppassword1;user2@gmail.com:apppassword2"
  // Prefix an entry with '-' to disable it while keeping the password.
  return {
    gmailUser,
    appPassword,
    forwardList,
    sinks: parseSinks(env.DEST_SINKS || ''),
    pollIntervalMs: Number(env.POLL_INTERVAL_MS || 60000),
    lookbackHours: Number(env.LOOKBACK_HOURS || 24),
    port: Number(env.PORT || 8788),
    dataDir: env.DATA_DIR || './data',
    adminToken: (env.ADMIN_TOKEN || '').trim(),
    dryRun: env.DRY_RUN === '1',
  };
}

// Per-sink health: a wrong/revoked App Password fails every APPEND.
// After AUTO_DISABLE_AFTER consecutive failures the sink is auto-disabled
// at runtime (reported in /api/status, skipped by polls) until a success
// (e.g. via test-forward after fixing DEST_SINKS) re-enables it.
// Deleted passwords need no tracking: parseSinks() drops empty entries,
// so they already show as "missing". Restarts reset counters (fresh try).
const sinkHealth = new Map(); // user -> { fails, autoDisabled }
const AUTO_DISABLE_AFTER = 3;

export function getAutoDisabled() {
  return [...sinkHealth.entries()].filter(([, h]) => h.autoDisabled).map(([u]) => u);
}

function noteSinkResult(user, ok) {
  let h = sinkHealth.get(user);
  if (!h) {
    h = { fails: 0, autoDisabled: false };
    sinkHealth.set(user, h);
  }
  if (ok) {
    h.fails = 0;
    if (h.autoDisabled) {
      h.autoDisabled = false;
      console.log(`[sinks] re-enabled ${user} (append succeeded)`);
    }
  } else {
    h.fails++;
    if (!h.autoDisabled && h.fails >= AUTO_DISABLE_AFTER) {
      h.autoDisabled = true;
      console.error(`[sinks] auto-disabled ${user} after ${h.fails} consecutive failures (wrong or revoked App Password?)`);
    }
  }
}

function isAutoDisabled(user) {
  return sinkHealth.get(user)?.autoDisabled === true;
}

// In-memory per-sink retry queue: replicateMessage() APPENDs raw bytes to
// every active sink in parallel. A partial failure (9/10 ok) must not be
// marked done and forgotten — failed (messageId → sink) pairs wait here
// until replicatePending() delivers them or they hit MAX_ATTEMPTS.
const pending = new Map(); // `${messageId}→${to}` -> { msg, to, attempts }
const MAX_ATTEMPTS = 5;
const MAX_PENDING = 500;

function pendingKey(messageId, to) {
  return `${messageId}→${to}`;
}

function appendFailureLog(cfg, suffix) {
  try {
    const dir = cfg?.dataDir || './data';
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch { /* ignore */ }
    fs.appendFileSync(path.join(dir, 'failures.log'), `${new Date().toISOString()} ${suffix}\n`);
  } catch { /* non-fatal */ }
}

function enqueuePending(cfg, msg, to, error) {
  const messageId = String(msg?.messageId || `uid-${msg?.uid || 'unknown'}`);
  const key = pendingKey(messageId, to);
  const prev = pending.get(key);
  const attempts = (prev?.attempts || 0) + 1;
  if (attempts >= MAX_ATTEMPTS) {
    if (prev) pending.delete(key);
    appendFailureLog(cfg, `PERMANENT messageId=${messageId} to=${to} attempts=${attempts} error=${String(error || 'append failed')}`);
    console.error(`[sinks] dropping ${key} after ${attempts} attempts (${String(error || 'append failed').slice(0, 120)})`);
    return;
  }
  if (!prev && pending.size >= MAX_PENDING) {
    const oldestKey = pending.keys().next().value;
    const oldest = pending.get(oldestKey);
    pending.delete(oldestKey);
    appendFailureLog(
      cfg,
      `PERMANENT messageId=${String(oldest?.msg?.messageId || 'unknown')} to=${oldest?.to || oldestKey} attempts=${oldest?.attempts || '?'} error=pending-overflow (dropped oldest, cap ${MAX_PENDING})`
    );
    console.error(`[sinks] pending overflow — dropped oldest ${oldestKey}`);
  }
  if (prev) {
    prev.msg = msg;
    prev.attempts = attempts;
  } else {
    pending.set(key, { msg, to, attempts });
  }
}

// No raw bodies, no passwords — safe for status surfaces.
export function getPending() {
  return [...pending.values()].map((e) => ({
    to: e.to,
    messageId: String(e.msg?.messageId || ''),
    attempts: e.attempts,
  }));
}

// Retry every pending (messageId → sink) pair via the same IMAP APPEND
// path. Updates attempts + sink health; caller decides Seen-flagging.
export async function replicatePending(cfg) {
  const entries = [...pending.entries()];
  const results = [];
  for (const [key, entry] of entries) {
    const { msg, to } = entry;
    const messageId = String(msg?.messageId || '');
    const sink = (cfg?.sinks || []).find((s) => s.user === to && s.enabled !== false);
    if (!sink) {
      noteSinkResult(to, false);
      const attempts = entry.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        pending.delete(key);
        appendFailureLog(cfg, `PERMANENT messageId=${messageId} to=${to} attempts=${attempts} error=sink missing or disabled`);
      } else {
        entry.attempts = attempts;
      }
      results.push({ to, messageId, uid: msg?.uid, ok: false, error: 'sink missing or disabled' });
      continue;
    }
    if (cfg?.dryRun) {
      noteSinkResult(to, true);
      pending.delete(key);
      results.push({ to, messageId, uid: msg?.uid, ok: true, dryRun: true });
      continue;
    }
    try {
      await appendToInbox(sink.user, sink.pass, msg.raw);
      noteSinkResult(to, true);
      pending.delete(key);
      results.push({ to, messageId, uid: msg?.uid, ok: true, via: 'append' });
    } catch (err) {
      noteSinkResult(to, false);
      const attempts = entry.attempts + 1;
      const errMsg = err?.message || String(err);
      if (attempts >= MAX_ATTEMPTS) {
        pending.delete(key);
        appendFailureLog(cfg, `PERMANENT messageId=${messageId} to=${to} attempts=${attempts} error=${errMsg}`);
        console.error(`[sinks] dropping ${key} after ${attempts} attempts (${errMsg.slice(0, 120)})`);
      } else {
        entry.attempts = attempts;
      }
      results.push({ to, messageId, uid: msg?.uid, ok: false, error: errMsg, code: err?.responseCode, appendFailed: true });
    }
  }
  return results;
}

// Direct mailbox COPY (Thunderbird-style): upload the raw message bytes
// into another account's INBOX via IMAP APPEND. Nothing is re-sent, so
// there is no SMTP, no send caps, and DKIM/SPF can never fail — the bytes
// are stored verbatim. Needs one App Password per destination account.
export async function appendToInbox(sinkUser, sinkPass, raw) {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: sinkUser, pass: sinkPass },
    logger: false,
    greetingTimeout: 15000,
    connectionTimeout: 30000,
    socketTimeout: 90000,
  });
  await client.connect();
  try {
    await client.append('INBOX', Buffer.from(raw, 'utf8'));
  } finally {
    try {
      await client.logout();
    } catch { /* ignore */ }
  }
}

// Parse DEST_SINKS="user1@gmail.com:pass1;user2@gmail.com:pass2" into pairs.
// App Passwords may contain spaces — everything after the first ':' is the
// password (spaces stripped, Gmail ignores them anyway).
// Prefix an entry with '-' to DISABLE it while keeping the password, e.g.
// "-team3@example.com:pass" stays configured but receives no copies
// until the '-' is removed. Disabled entries are reported, never used.
export function parseSinks(raw) {
  return (raw || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const enabled = !entry.startsWith('-');
      if (!enabled) entry = entry.slice(1).trim();
      const i = entry.indexOf(':');
      if (i < 0) return null;
      const user = entry.slice(0, i).trim();
      const pass = entry.slice(i + 1).replace(/\s+/g, '');
      return user && pass ? { user, pass, enabled } : null;
    })
    .filter(Boolean);
}

function getHeaderText(headers, name) {
  const v = headers.get(name);
  if (!v) return '';
  return Array.isArray(v) ? String(v[0] || '') : String(v);
}

// Fetch UNSEEN messages since lookback window. Returns raw RFC822 per message.
// Does NOT mark anything Seen unless markSeen is true (caller decides,
// so a huge backlog can be baselined without forwarding first).
export async function fetchNewMessages(cfg, { markSeen = false } = {}) {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: cfg.gmailUser, pass: cfg.appPassword },
    logger: false,
    // Fail fast instead of hanging forever if Gmail throttles us.
    greetingTimeout: 15000,
    connectionTimeout: 30000,
    socketTimeout: 90000,
  });
  await client.connect();
  try {
    await client.mailboxOpen('INBOX');
    const since = new Date(Date.now() - cfg.lookbackHours * 3600 * 1000);
    const out = [];
    // UNSEEN + SINCE keeps first run bounded; steady-state is just UNSEEN.
    for await (const msg of client.fetch({ seen: false, since }, {
      envelope: true,
      headers: true,
      bodyParts: ['TEXT'],
      source: true,
    })) {
      const headers = msg.headers; // Map-like from imapflow
      const get = (n) => {
        try {
          return getHeaderText(headers, n);
        } catch {
          return '';
        }
      };
      const raw = msg.source?.toString('utf8') || '';
      out.push({
        uid: msg.uid,
        messageId: get('message-id') || `uid-${msg.uid}`,
        from: get('from'),
        to: get('to'),
        subject: get('subject'),
        date: get('date'),
        raw,
      });
      if (markSeen) {
        try {
          await client.messageFlagsAdd(msg.uid, ['\\Seen']);
        } catch { /* non-fatal */ }
      }
    }
    return out;
  } finally {
    try {
      await client.logout();
    } catch { /* ignore */ }
  }
}

// Lightweight UNSEEN count (no bodies) — used to decide baseline vs process.
export async function countUnseen(cfg) {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: cfg.gmailUser, pass: cfg.appPassword },
    logger: false,
    greetingTimeout: 15000,
    connectionTimeout: 30000,
    socketTimeout: 90000,
  });
  await client.connect();
  try {
    await client.mailboxOpen('INBOX');
    const since = new Date(Date.now() - cfg.lookbackHours * 3600 * 1000);
    const uids = await client.search({ seen: false, since });
    return uids;
  } finally {
    try {
      await client.logout();
    } catch { /* ignore */ }
  }
}
// Mark specific UIDs as Seen (used after a message is handled, or to
// baseline a backlog without forwarding it).
export async function markUidsSeen(cfg, uids) {
  if (!uids.length) return;
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: cfg.gmailUser, pass: cfg.appPassword },
    logger: false,
    greetingTimeout: 15000,
    connectionTimeout: 30000,
    socketTimeout: 90000,
  });
  await client.connect();
  try {
    await client.mailboxOpen('INBOX');
    await client.messageFlagsAdd(uids, ['\\Seen']);
  } finally {
    try {
      await client.logout();
    } catch { /* ignore */ }
  }
}
// Skips actual SMTP when dryRun is on.
// Auto-generated bounces/NDRs must never be re-blasted to the team
// (our own failure notices land in the source inbox too).
export function isAutoNotice(parsed, raw) {
  const auto = String(parsed.headers.get('auto-submitted') || '').toLowerCase();
  if (auto && auto !== 'no') return true;
  const from = String(parsed.from?.text || '').toLowerCase();
  if (from.includes('mailer-daemon') || from.includes('postmaster')) return true;
  const ct = String(parsed.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('multipart/report')) return true;
  if (/^return-path:\s*<>/im.test(raw)) return true;
  return false;
}

// Copy one message's raw bytes into every active destination mailbox via
// IMAP APPEND (Thunderbird-style). Nothing is ever re-sent: the bytes are
// stored verbatim, so there are no send caps and DKIM/SPF can never fail.
export async function replicateMessage(cfg, msg, { forwardList } = {}) {
  const list = forwardList || cfg.forwardList;
  const parsed = await simpleParser(Buffer.from(msg.raw, 'utf8'));
  if (isAutoNotice(parsed, msg.raw)) {
    return list.map((rcpt) => ({ to: rcpt, ok: true, skipped: 'auto-notice' }));
  }

  // Same raw bytes into every active mailbox, in parallel (each sink is a
  // different account, so limits are independent).
  // Sinks disabled with a '-' prefix in DEST_SINKS are skipped (kept for config).
  // Sinks auto-disabled after repeated APPEND failures are skipped too.
  const active = cfg.sinks.filter((s) => s.enabled !== false && !isAutoDisabled(s.user));
  if (!active.length) {
    if (!cfg.sinks.length) console.error('[send] DEST_SINKS is empty — skipping. Fill per-inbox App Passwords in .env.');
    else console.error('[send] all sinks are disabled (-) — skipping.');
    // No code => transient => stays unseen, retried next poll (no silent loss).
    return list.map((rcpt) => ({ to: rcpt, ok: false, error: 'DEST_SINKS empty' }));
  }
  const settled = await Promise.allSettled(
    active.map(async (sink) => {
      if (cfg.dryRun) return { sink: sink.user, dryRun: true };
      await appendToInbox(sink.user, sink.pass, msg.raw);
      return { sink: sink.user };
    })
  );
  return settled.map((s, i) => {
    const rcpt = active[i].user;
    if (s.status === 'fulfilled') {
      noteSinkResult(rcpt, true);
      return s.value.dryRun
        ? { to: rcpt, ok: true, dryRun: true }
        : { to: rcpt, ok: true, via: 'append' };
    }
    noteSinkResult(rcpt, false);
    const error = s.reason?.message || String(s.reason);
    return { to: rcpt, ok: false, error, code: s.reason?.responseCode, appendFailed: true };
  }).map((r) => {
    if (!r.ok) enqueuePending(cfg, msg, r.to, r.error);
    return r;
  });
}

// Build a small test message and APPEND it to every active sink.
// Used by POST /api/test-forward to prove end-to-end delivery.
export async function appendTestMessage(cfg, to) {
  const active = cfg.sinks.filter((s) => s.enabled !== false);
  if (!active.length) throw new Error('DEST_SINKS is empty (or all disabled)');
  const target = (to || '').trim() || active[0].user;
  const raw = [
    `From: "sinka" <${cfg.gmailUser}>`,
    `To: ${target}`,
    'Subject: sinka test — replicator is working',
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <sinka-test-${Date.now()}@example.com>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'This is a test copy filed by the sinka replicator. No action needed.',
    '',
  ].join('\r\n');
  if (cfg.dryRun) return { dryRun: true, to: target };
  const settled = await Promise.allSettled(
    active.map(async (sink) => {
      await appendToInbox(sink.user, sink.pass, raw);
      return { sink: sink.user };
    })
  );
  // Test intentionally tries every enabled sink (including auto-disabled
  // ones) so fixing a password + re-testing re-enables it on success.
  return {
    to: target,
    results: settled.map((s, i) => {
      const ok = s.status === 'fulfilled';
      noteSinkResult(active[i].user, ok);
      return ok
        ? { to: active[i].user, ok: true, via: 'append' }
        : { to: active[i].user, ok: false, error: s.reason?.message || String(s.reason) };
    }),
  };
}
