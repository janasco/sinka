import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { createStoreAuto } from './store_d1.js';
import { loadConfig, parseSinks, fetchNewMessages, countUnseen, markUidsSeen, replicateMessage, replicatePending, getPending, appendTestMessage, getAutoDisabled } from './mail.js';

const args = new Set(process.argv.slice(2));
const runOnce = args.has('--once');

let cfg;
let setupNeeded = null;
try {
  cfg = loadConfig();
} catch (err) {
  // Preview mode: let the UI boot so sinka.example.com can be checked
  // before the Gmail App Password is set. Polling stays disabled.
  if ((err?.message || '').includes('GMAIL_APP_PASSWORD')) {
    setupNeeded = err.message;
    console.error('Config warning (preview mode):', err.message);
    const list = (process.env.FORWARD_LIST || 'team1@example.com,team2@example.com,team3@example.com,team4@example.com,team5@example.com,team6@example.com,team7@example.com,team8@example.com,team9@example.com,team10@example.com')
      .split(',').map((s) => s.trim()).filter(Boolean);
    cfg = {
      gmailUser: (process.env.GMAIL_USER || 'you@example.com').trim(),
      appPassword: '',
      forwardList: list,
      sinks: parseSinks(process.env.DEST_SINKS || ''),
      pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 60000),
      lookbackHours: Number(process.env.LOOKBACK_HOURS || 24),
      port: Number(process.env.PORT || 8788),
      dataDir: process.env.DATA_DIR || './data',
      adminToken: (process.env.ADMIN_TOKEN || '').trim(),
      dryRun: process.env.DRY_RUN === '1',
    };
  } else {
    console.error('Config error:', err.message);
    console.error('Copy .env.example to .env and fill required values.');
    process.exit(1);
  }
}

const store = createStoreAuto(cfg.dataDir);
await store.ready();
const state = {
  startedAt: new Date().toISOString(),
  lastPollAt: null,
  lastResult: null,
  consecutiveErrors: 0,
};

let polling = false; // single-flight: never overlap polls on one Gmail account
let nextAllowedAt = 0; // error backoff: Gmail throttle protection
let alerted = false; // outage alert: true once ntfy fired for current error streak
// Watchdog: never let one wedged IMAP session hang a poll forever.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
const IMAP_BUDGET_MS = 240000;
async function poll(reason = 'timer') {
  if (polling) {
    console.log(`[poll] skipped (${reason}): previous poll still running`);
    return { reason, skipped: true, busy: true };
  }
  if (reason === 'timer' && Date.now() < nextAllowedAt) {
    return { reason, skipped: true, backedOff: true };
  }
  polling = true;
  try {
    if (setupNeeded) {
      state.lastPollAt = new Date().toISOString();
      state.lastResult = { reason, error: setupNeeded };
      console.error('[poll] skipped:', setupNeeded);
      return state.lastResult;
    }
    const started = Date.now();
    try {
    // First-run safety: if the inbox already holds a big UNSEEN backlog,
    // do NOT blast thousands of copies (Gmail caps ~500 sends/day).
    // Baseline instead: mark all as Seen, forward nothing. Only genuinely
    // new arrivals after this point get replicated.
    const CATCHUP_LIMIT = Number(process.env.CATCHUP_LIMIT || 25);
    // Cheap count first: baselining 1000 old messages must not download bodies.
    const pendingUids = await withTimeout(countUnseen(cfg), IMAP_BUDGET_MS, 'countUnseen');
    if (store.size() === 0 && pendingUids.length > CATCHUP_LIMIT) {
      await markUidsSeen(cfg, pendingUids);
      state.lastPollAt = new Date().toISOString();
      state.lastResult = {
        reason,
        ms: Date.now() - started,
        fetched: pendingUids.length,
        replicated: 0,
        skipped: 0,
        baselined: pendingUids.length,
        destinations: cfg.forwardList.length,
        details: [],
      };
      console.log(`[poll] BASELINED ${pendingUids.length} existing messages (no forwarding). New mail from here on will be replicated.`);
      state.consecutiveErrors = 0;
      alerted = false;
      return state.lastResult;
    }
    const messages = await withTimeout(fetchNewMessages(cfg), IMAP_BUDGET_MS, 'fetchNewMessages');
    let replicated = 0;
    let skipped = 0;
    let retried = 0;
    const details = [];
    const uidsToFlag = [];
    // Retry previously failed per-sink copies FIRST — this is the sole
    // retry path. Every touched message is then filed Seen+stored so it
    // is never refetched; remaining failures stay queued for later polls
    // (no duplicate copies, no refetch storms).
    try {
      const retryResults = await withTimeout(replicatePending(cfg), IMAP_BUDGET_MS, 'replicatePending');
      const retriedIds = new Map();
      for (const r of retryResults) {
        if (r.ok) retried++;
        if (r.messageId && !retriedIds.has(r.messageId)) retriedIds.set(r.messageId, r.uid);
      }
      for (const [id, uid] of retriedIds) {
        store.add(id);
        if (uid != null) uidsToFlag.push(uid);
      }
      if (retryResults.length) {
        details.push({ messageId: `retries (${retryResults.length} attempt${retryResults.length === 1 ? '' : 's'})`, from: '', subject: '', results: retryResults.map((r) => ({ to: r.to, ok: r.ok, ...(r.ok ? { via: r.via || 'append' } : { error: r.error }) })) });
        console.log(`[poll] retries ok=${retryResults.filter((r) => r.ok).length}/${retryResults.length}`);
      }
    } catch (err) {
      console.error('[poll] retry pass failed (main flow continues):', err?.message || err);
    }
    for (const msg of messages) {
      const mStart = Date.now();
      if (store.has(msg.messageId)) {
        uidsToFlag.push(msg.uid);
        skipped++;
        continue;
      }
      const results = await replicateMessage(cfg, msg);
      const failed = results.filter((r) => !r.ok);
      const skippedNotice = results.length > 0 && results.every((r) => r.skipped);
      if (skippedNotice) {
        // Bounces/auto-replies: never re-blast, just file away.
        store.add(msg.messageId);
        uidsToFlag.push(msg.uid);
        skipped++;
        details.push({ messageId: msg.messageId, from: msg.from, subject: msg.subject, results });
        continue;
      }
      // Record as seen when at least one copy went out (or dry-run).
      // Permanent rejections (5xx, e.g. policy blocks) will never succeed —
      // file them to the failure log instead of retry-looping burns.
      // Transient errors stay unseen for the next poll.
      const permanent = failed.length > 0 && failed.every((r) => Number(r.code) >= 500 && Number(r.code) < 600);
      if (failed.length < results.length || cfg.dryRun) {
        store.add(msg.messageId);
        uidsToFlag.push(msg.uid);
        replicated++;
      } else if (permanent) {
        store.add(msg.messageId);
        uidsToFlag.push(msg.uid);
        try {
          fs.appendFileSync(
            path.join(cfg.dataDir, 'failures.log'),
            `${new Date().toISOString()} PERMANENT messageId=${msg.messageId} from=${msg.from} subject=${msg.subject} errors=${JSON.stringify(failed)}\n`
          );
        } catch { /* non-fatal */ }
        console.error(`[poll] permanent failure, filed (no retry): ${msg.messageId} ${failed[0]?.error}`);
      }
      details.push({ messageId: msg.messageId, from: msg.from, subject: msg.subject, results });
      console.log(`[poll] msg done subject=${JSON.stringify((msg.subject || '').slice(0, 60))} ok=${failed.length < results.length} failed=${failed.length}/${results.length} (${Date.now() - mStart}ms)`);
    }
    // Single flag session for the whole poll (not one connection per message).
    if (uidsToFlag.length) {
      try {
        await withTimeout(markUidsSeen(cfg, uidsToFlag), IMAP_BUDGET_MS, 'markUidsSeen');
      } catch (err) {
        console.error('[poll] flagging failed (will retry next poll):', err?.message || err);
      }
    }
    state.lastPollAt = new Date().toISOString();
    state.lastResult = {
      reason,
      ms: Date.now() - started,
      fetched: messages.length,
      replicated,
      retried,
      skipped,
      pending: getPending().length,
      destinations: cfg.forwardList.length,
      details: details.slice(0, 20),
    };
    state.consecutiveErrors = 0;
    alerted = false;
    console.log(`[poll] fetched=${messages.length} replicated=${replicated} retried=${retried} skipped=${skipped} pending=${getPending().length} (${state.lastResult.ms}ms)`);
    return state.lastResult;
    } catch (err) {
      state.consecutiveErrors++;
      // Back off on errors (throttle protection): 5min, 10min, 20min... capped at 60min.
      const backoffMs = Math.min(3600000, 300000 * Math.pow(2, state.consecutiveErrors - 1));
      nextAllowedAt = Date.now() + backoffMs;
      state.lastPollAt = new Date().toISOString();
      state.lastResult = { reason, error: err?.message || String(err) };
      console.error('[poll] failed:', err?.message || err, `(backing off ${Math.round(backoffMs / 60000)}min)`);
      // Outage alerting: notify once when this streak FIRST reaches threshold.
      // Empty topic = disabled. Fire-and-forget; alert failure never breaks polling.
      try {
        const parsedThreshold = Number.parseInt(String(process.env.ALERT_THRESHOLD ?? '3'), 10);
        const threshold = Number.isFinite(parsedThreshold) && parsedThreshold >= 1 ? parsedThreshold : 3;
        const topic = (process.env.ALERT_NTFY_TOPIC || '').trim();
        if (!alerted && topic && state.consecutiveErrors >= threshold) {
          alerted = true;
          fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
            method: 'POST',
            body: `${state.consecutiveErrors} consecutive poll errors: ${err?.message || String(err)}. Dashboard needs attention.`,
            headers: { Title: 'sinka poll failing', Priority: 'high', Tags: 'warning' },
            signal: AbortSignal.timeout(10000),
          }).catch((alertErr) => console.error('[alert] ntfy failed:', alertErr?.message || alertErr));
        }
      } catch (alertErr) {
        console.error('[alert] ntfy failed:', alertErr?.message || alertErr);
      }
      return state.lastResult;
    }
  } finally {
    polling = false;
  }
}

// ---- Minimal private UI (Cloudflare Access Email OTP sits in front) ----
const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());

function requireAdmin(req, res, next) {
  if (!cfg.adminToken) return next(); // rely on Cloudflare Access
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token === cfg.adminToken) return next();
  return res.status(401).json({ success: false, error: 'Unauthorized' });
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

app.get('/', (_req, res) => {
  const sinkUsers = new Set(cfg.sinks.filter((s) => s.enabled !== false).map((s) => s.user));
  const disUsers = new Set(cfg.sinks.filter((s) => s.enabled === false).map((s) => s.user));
  const autoUsers = new Set(getAutoDisabled());
  const live = cfg.forwardList.filter((a) => sinkUsers.has(a) && !autoUsers.has(a));
  const paused = cfg.forwardList.filter((a) => autoUsers.has(a));
  const off = cfg.forwardList.filter((a) => disUsers.has(a));
  const miss = cfg.forwardList.filter((a) => !sinkUsers.has(a) && !disUsers.has(a));
  // First-paint fallback: identical shape to renderDests()'s tile() below (the client is the
  // visual source of truth; this is replaced on the first refresh).
  const tile = (a, cls) => `<div class="tile ${cls}" data-user="${escHtml(a)}" title="${escHtml(a)}"><div class="t-name">${escHtml(a)}</div><div class="t-foot"><span class="t-count">0</span><span class="t-unit">copies</span></div><div class="spark">${'<i></i>'.repeat(12)}</div></div>`;
  const grp = (title, arr, cls) => (arr.length
    ? `<div class="grp"><span class="grp-k">${escHtml(title)}</span><span class="grp-n">${arr.length}</span></div><div class="tiles">${arr.map((a) => tile(a, cls)).join('')}</div>`
    : '');
  // Group titles mirror renderDests() below so first paint matches the client re-render.
  const destHtml = grp('Copying right now', live, 'on')
    + grp('Sign-in failed, waiting for you', paused, 'auto')
    + grp('Paused by you', off, 'off')
    + grp('No sign-in details yet', miss, 'miss')
    + `<p class="pipe-foot">Nothing is copied to a tile until a copy really lands, so every count starts at zero.</p>`;
  res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="description" content="sinka dashboard: does mail copying work, what is it doing right now, and what needs fixing.">
<title>sinka &middot; is mail copying?</title>
<style>
:root{
  color-scheme:dark;
  --bg:#05070B; --bg-2:#090D14; --card:#0E121A; --card-2:#121826;
  --line:#1A2333; --line-2:#273349;
  --field:#212C42; --field-line:#5A6B8C;
  --ink:#F1F5F9; --silver:#E2E8F0; --mut:#8A99AE;
  --ok:#34D399; --warn:#FBBF24; --err:#F87171; --acc:#38BDF8; --lav:#A78BFA;
  --btn-bg:#38BDF8; --btn-fg:#04121F;
  --pad:1.25rem; --r:14px; --rs:10px;
  --fs-xs:.8125rem; --fs-s:.875rem; --fs-m:.9375rem; --fs-l:1.125rem; --fs-xl:1.5rem;
  --sans:"Geist Sans",Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --ease:cubic-bezier(.16,1,.3,1);
}
@media (prefers-color-scheme:light){
  :root{
    color-scheme:light;
    --bg:#F5F7FA; --bg-2:#EAEFF5; --card:#FFFFFF; --card-2:#EFF3F9;
    --line:#E1E7EF; --line-2:#C8D2E0;
    --field:#FFFFFF; --field-line:#6B7A93;
    --ink:#0F172A; --silver:#1E293B; --mut:#5A6B80;
    --ok:#15803D; --warn:#A16207; --err:#B91C1C; --acc:#0369A1; --lav:#6D28D9;
    --btn-bg:#0369A1; --btn-fg:#FFFFFF;
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg); color:var(--ink);
  font:400 var(--fs-m)/1.55 var(--sans); letter-spacing:-.002em;
  padding:0 1.25rem 3rem;
}
code{font-family:var(--mono);font-size:1em;background:var(--card-2);border:1px solid var(--line);border-radius:5px;padding:.05rem .32rem;word-break:break-word}
h1,h2,h3,p,ul,ol{margin:0}
.wrap{max-width:1060px;margin:0 auto}
.vh{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
a{color:var(--acc)}
:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:6px}

/* ---- 1. masthead ---- */
.masthead{display:flex;flex-wrap:wrap;align-items:flex-end;gap:.5rem 1.5rem;padding:1.75rem 0 1.1rem;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:baseline;gap:.55rem;flex-wrap:wrap}
.brand h1{font-size:var(--fs-l);font-weight:600;letter-spacing:-.02em}
.brand h1 .mark{color:var(--acc)}
.tagline{color:var(--silver);font-size:var(--fs-m)}
.flowline{color:var(--mut);font-size:var(--fs-s);margin-left:auto;text-align:right}
.flowline b{color:var(--silver);font-weight:600}
.badges{display:flex;gap:.4rem;flex-wrap:wrap;width:100%;padding-top:.15rem}
.badge{font-size:var(--fs-xs);border:1px solid var(--line);border-radius:999px;padding:.2rem .65rem;background:var(--card);color:var(--silver)}
.badge.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 45%,var(--line))}
.badge.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 55%,var(--line))}

/* ---- shared card + section rhythm ---- */
.stack{display:flex;flex-direction:column;gap:1.1rem;padding-top:1.1rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:var(--pad)}
.sec-head{display:flex;align-items:baseline;justify-content:space-between;gap:.5rem 1rem;flex-wrap:wrap;margin-bottom:.9rem}
.sec-head h2{font-size:var(--fs-m);font-weight:600;letter-spacing:-.01em}
.sec-sub{color:var(--mut);font-size:var(--fs-s)}
.sec-aside{color:var(--mut);font-size:var(--fs-s);white-space:nowrap}

/* ---- 2. hero: the one-line answer ---- */
.hero{display:flex;flex-wrap:wrap;align-items:center;gap:var(--pad)}
.hero-face{width:2.75rem;height:2.75rem;flex:0 0 auto;display:grid;place-items:center;border-radius:12px;font-size:1.05rem;line-height:1;background:var(--card-2);border:1px solid var(--line-2);color:var(--mut)}
.hero-body{flex:1 1 18rem;min-width:0}
.hero-t{font-size:var(--fs-xl);font-weight:600;letter-spacing:-.02em;line-height:1.2}
.hero-s{color:var(--mut);font-size:var(--fs-s);margin-top:.25rem}
.hero-back{margin-top:.5rem;font-size:var(--fs-s);color:var(--acc);border:1px solid color-mix(in srgb,var(--acc) 40%,var(--line));border-radius:999px;padding:.2rem .7rem;display:inline-block;background:color-mix(in srgb,var(--acc) 8%,var(--card))}
.hero-new{display:inline-block;margin-top:.6rem;font-size:var(--fs-s);color:var(--acc);text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--acc) 40%,transparent)}
.hero-new:hover{border-bottom-color:var(--acc)}
.hero-side{flex:0 0 auto;text-align:right;border-left:1px solid var(--line);padding-left:var(--pad);align-self:stretch;display:flex;flex-direction:column;justify-content:center}
.hero-side .k{color:var(--mut);font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:.08em}
.hero-side .v{font-size:var(--fs-l);font-weight:600;font-variant-numeric:tabular-nums;margin-top:.15rem}
.hero-side .v .u{font-size:var(--fs-m);color:var(--mut);font-weight:500;margin-left:.1rem}
.hero-side .s{color:var(--mut);font-size:var(--fs-xs);margin-top:.15rem;max-width:16rem;margin-left:auto}
.rail{margin-top:.6rem;padding-top:.5rem;border-top:1px dashed var(--line)}
.rail .r{display:flex;gap:.5rem;justify-content:space-between;font-size:var(--fs-xs);color:var(--mut);padding:.1rem 0}
.rail .r .k{text-transform:none;letter-spacing:0}
.rail .r b{color:var(--silver);font-weight:600;font-variant-numeric:tabular-nums}
.hero.ok{border-color:color-mix(in srgb,var(--ok) 40%,var(--line))}
.hero.ok .hero-face{color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,var(--card))}
.hero.ok .hero-t{color:var(--ok)}
.hero.warn{border-color:color-mix(in srgb,var(--warn) 50%,var(--line))}
.hero.warn .hero-face{color:var(--warn);background:color-mix(in srgb,var(--warn) 12%,var(--card))}
.hero.warn .hero-t{color:var(--warn)}
.hero.err{border-color:color-mix(in srgb,var(--err) 50%,var(--line))}
.hero.err .hero-face{color:var(--err);background:color-mix(in srgb,var(--err) 12%,var(--card))}
.hero.err .hero-t{color:var(--err)}
/* server out of reach: this page cannot vouch for anything below */
.hero.down{border-color:var(--err);border-style:dashed;background:color-mix(in srgb,var(--err) 6%,var(--card))}
.hero.down .hero-face{color:var(--err);background:color-mix(in srgb,var(--err) 14%,var(--card))}
.hero.down .hero-t{color:var(--err)}
.hero.down .rail .r b{color:var(--err)}

/* ---- 3. alerts ---- */
.alerts{display:flex;flex-direction:column;gap:.5rem}
.alerts:empty{display:none}
.alert{border:1px solid var(--line);border-left-width:3px;border-radius:var(--rs);padding:.7rem .9rem;font-size:var(--fs-s);background:var(--card-2)}
.alert b{color:var(--ink)}
.alert.err{border-color:var(--line);border-left-color:var(--err)}
.alert.err b{color:var(--err)}
.alert.warn{border-color:var(--line);border-left-color:var(--warn)}
.alert.warn b{color:var(--warn)}
.alert.note{border-color:var(--line);border-left-color:var(--line-2)}
.alert.note b{color:var(--silver)}

/* ---- 4. the fix strip (narrow screens only) ---- */
#fix{display:none}
.fix-t{font-size:var(--fs-s);color:var(--silver)}

/* ---- 5. pipeline ---- */
.pipe{position:relative;display:grid;gap:.7rem;padding:var(--pad);border:1px solid var(--line);border-radius:var(--r);background:var(--card-2);overflow:hidden}
.pipe::before{content:"";position:absolute;inset:0;background:radial-gradient(ellipse 55% 80% at 50% 45%,color-mix(in srgb,var(--acc) 7%,transparent),transparent 70%);pointer-events:none}
.srcrow{position:relative;display:flex;align-items:center;gap:.55rem;flex-wrap:wrap;font-size:var(--fs-s);color:var(--mut)}
.srcrow .k{text-transform:uppercase;letter-spacing:.08em;font-size:var(--fs-xs)}
.srcrow .v{font-family:var(--mono);font-size:var(--fs-s);color:var(--silver);word-break:break-all}
.srcrow .state{margin-left:auto;font-size:var(--fs-xs);color:var(--mut);border:1px solid var(--line);border-radius:999px;padding:.15rem .6rem;background:var(--card)}
/* the dot's colour is the status: no animation, so nothing pretends to be live */
.srcdot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--ok);flex:0 0 auto}
.srcdot.idle{background:var(--err)}
.srcdot.dead{background:var(--mut);box-shadow:0 0 0 3px color-mix(in srgb,var(--mut) 20%,transparent)}
.conduit{position:relative;height:22px;border-radius:6px;background:linear-gradient(90deg,transparent,var(--lav) 50%,transparent) 0 50%/64px 2px repeat-x;opacity:.22}
.conduit .pkt{position:absolute;top:50%;left:0;width:7px;height:7px;margin-top:-3.5px;border-radius:50%;background:var(--acc);box-shadow:0 0 8px 2px color-mix(in srgb,var(--acc) 70%,transparent);opacity:0}
.conduit.live{opacity:.75}
.conduit.live .pkt{animation:travel 2.2s linear 1}
@keyframes travel{0%{left:0;opacity:0}12%{opacity:1}88%{opacity:1}100%{left:calc(100% - 7px);opacity:0}}
.dests{position:relative;display:flex;flex-direction:column;gap:.15rem}
.grp{display:flex;align-items:center;gap:.45rem;margin:.55rem 0 .35rem;padding-top:.55rem;border-top:1px dashed var(--line)}
.grp:first-child{margin-top:0;padding-top:0;border-top:0}
.grp-k{font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:.08em;color:var(--mut)}
.grp-n{font-size:var(--fs-xs);color:var(--silver);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:.05rem .45rem;font-variant-numeric:tabular-nums}
.grp.retry .grp-k{color:var(--lav)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:.5rem}
.tile{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--line-2);border-radius:var(--rs);padding:.55rem .7rem;transition:background-color .15s var(--ease),border-color .15s var(--ease),transform .15s var(--ease)}
.tile:hover{background:var(--bg-2);transform:translateY(-1px)}
.tile .t-name{font-family:var(--mono);font-size:var(--fs-xs);color:var(--silver);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:ltr}
.tile .t-foot{display:flex;align-items:baseline;gap:.35rem;margin-top:.2rem}
.tile .t-count{font-size:var(--fs-l);font-weight:600;font-variant-numeric:tabular-nums;line-height:1.15;color:var(--silver)}
.tile .t-unit{font-size:var(--fs-xs);color:var(--mut)}
.tile .t-note{font-size:var(--fs-xs);color:var(--mut);margin-top:.1rem}
.tile .t-note.jn{color:var(--ok);font-weight:600}
.tile.on{border-left-color:var(--ok)}
.tile.on .t-count{color:var(--ok)}
.tile.off{opacity:.62}
.tile.miss{border-left-color:var(--warn)}
.tile.miss .t-count{color:var(--warn)}
.tile.auto{border-left-color:var(--err)}
.tile.auto .t-count{color:var(--err)}
/* purple, not amber: a queued retry is not a mistake of the operator's */
.tile.retry{border-left-color:var(--lav)}
.tile.retry .t-count{color:var(--lav)}
/* reduced-motion substitute for the 800ms APPEND flash: a lasting mark */
.tile.jn{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ok) 55%,transparent)}
.tile.flash{background:color-mix(in srgb,var(--ok) 16%,var(--card));border-color:var(--ok);transition:background-color .1s var(--ease)}
.spark{display:flex;align-items:flex-end;gap:2px;height:16px;margin-top:.35rem}
.spark i{flex:1;background:var(--lav);opacity:.3;border-radius:1px;min-height:2px}
.spark i.hot{background:var(--ok);opacity:1}
.pipe-foot{margin-top:.6rem;font-size:var(--fs-xs);color:var(--mut)}
.legend{display:flex;flex-wrap:wrap;gap:.35rem .9rem;list-style:none;margin:.9rem 0 0;padding:.8rem 0 0;border-top:1px solid var(--line);font-size:var(--fs-xs);color:var(--mut)}
.legend li{display:inline-flex;align-items:center;gap:.4rem}
.sw{width:.6rem;height:.6rem;border-radius:3px;flex:0 0 auto;background:var(--mut)}
.sw-ok{background:var(--ok)}.sw-warn{background:var(--warn)}.sw-err{background:var(--err)}.sw-off{background:var(--mut)}.sw-lav{background:var(--lav)}
.sw-dot{background:var(--ok);border-radius:50%;box-shadow:0 0 0 2px color-mix(in srgb,var(--ok) 30%,transparent)}

/* ---- 6. numbers ---- */
.mgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:.6rem}
.metric{background:var(--card-2);border:1px solid var(--line);border-radius:var(--rs);padding:.7rem .8rem}
.metric .k{font-size:var(--fs-xs);color:var(--mut)}
.metric .v{font-size:var(--fs-xl);font-weight:600;font-variant-numeric:tabular-nums;line-height:1.15;margin-top:.2rem;letter-spacing:-.02em}
.metric .v.word{font-size:var(--fs-l)}
.metric .s{font-size:var(--fs-xs);color:var(--mut);margin-top:.15rem;min-height:1.2em}
.metric.good .v{color:var(--ok)}
.metric.zero .v{color:var(--mut)}
.ticker{margin-top:.9rem;padding-top:.85rem;border-top:1px solid var(--line);font-size:var(--fs-xs);color:var(--mut)}
.frozen-note{margin-top:.6rem;font-size:var(--fs-xs);color:var(--err);border-left:3px solid var(--err);padding:.3rem 0 .3rem .6rem}
/* nothing below is moving: dim it rather than let it look live */
body.frozen .mgrid,body.frozen .dests,body.frozen #details,body.frozen .cklist{opacity:.5;filter:saturate(.55)}

/* ---- 7. actions ---- */
.actlist{display:flex;flex-direction:column;gap:.8rem}
.act{background:var(--card-2);border:1px solid var(--line);border-radius:var(--rs);padding:.85rem .9rem}
.act.care{border-color:color-mix(in srgb,var(--err) 40%,var(--line))}
.act h3{font-size:var(--fs-s);font-weight:600}
.act p{font-size:var(--fs-xs);color:var(--mut);margin-top:.15rem}
.act-btns{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.6rem}
.field{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin-top:.6rem}
.field label{font-size:var(--fs-xs);color:var(--mut);width:100%}
.step-n{display:inline-grid;place-items:center;width:1.15rem;height:1.15rem;border-radius:50%;background:var(--card);border:1px solid var(--line-2);color:var(--acc);font-size:var(--fs-xs);font-weight:700;margin-right:.35rem;vertical-align:1px}
/* coral marks the one thing that cannot be undone; amber is reserved for "needs you" */
.chip{display:inline-block;font-size:var(--fs-xs);font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--err);border:1px solid color-mix(in srgb,var(--err) 55%,var(--line));border-radius:999px;padding:.1rem .5rem;margin-right:.4rem;vertical-align:1px}
button,input{font:inherit;color:var(--ink)}
button{background:var(--btn-bg);color:var(--btn-fg);border:1px solid transparent;border-radius:9px;padding:.5rem .95rem;font-size:var(--fs-s);font-weight:600;cursor:pointer;transition:transform .15s var(--ease),opacity .15s var(--ease),background-color .15s var(--ease),border-color .15s var(--ease)}
button:hover:not(:disabled){transform:translateY(-1px);opacity:.93}
button:active:not(:disabled){transform:translateY(0)}
button:disabled{opacity:.45;cursor:not-allowed}
button.ghost{background:transparent;color:var(--silver);border-color:var(--line-2)}
button.ghost:hover:not(:disabled){background:var(--card);border-color:var(--acc);color:var(--acc)}
button.care{background:transparent;color:var(--err);border-color:color-mix(in srgb,var(--err) 55%,var(--line))}
button.care:hover:not(:disabled){background:color-mix(in srgb,var(--err) 12%,transparent)}
/* inputs sit on their own raised surface with a clearly visible edge (3:1 or better) */
input[type=text],input[type=password]{background:var(--field);border:1px solid var(--field-line);border-radius:9px;padding:.5rem .65rem;font-size:var(--fs-s);min-width:0;flex:1 1 12rem;transition:border-color .15s var(--ease)}
input::placeholder{color:var(--mut);opacity:1}
input:hover{border-color:var(--acc)}
input:focus{border-color:var(--acc)}
#result{margin-top:.8rem;border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:var(--rs);background:var(--card-2);padding:.7rem .8rem}
#result .r-out{font-size:var(--fs-s);color:var(--ink)}
#result .r-meta{font-size:var(--fs-xs);color:var(--mut);margin-top:.25rem}
#result .r-raw{margin-top:.5rem;font-size:var(--fs-xs);color:var(--mut)}
#result-json{margin:.5rem 0 0;padding:.6rem;background:var(--card);border:1px solid var(--line);border-radius:8px;max-height:220px;overflow:auto;font-family:var(--mono);font-size:var(--fs-xs);line-height:1.5;color:var(--silver);white-space:pre-wrap}

/* ---- 8. latest mail ---- */
.latest{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:var(--fs-s)}
th,td{text-align:left;padding:.45rem .5rem;border-top:1px solid var(--line);vertical-align:top}
th{border-top:0;color:var(--mut);font-weight:600;font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:.06em}
td.id{white-space:nowrap;color:var(--mut);font-size:var(--fs-xs)}
td .subj{color:var(--silver)}
td .fr{display:block;color:var(--mut);font-size:var(--fs-xs);margin-top:.1rem}
summary{cursor:pointer;font-size:var(--fs-s);color:var(--mut)}
summary:hover{color:var(--acc)}
details ul{margin:.3rem 0 .1rem;padding-left:1.1rem;font-size:var(--fs-xs);color:var(--mut)}
details li{margin:.1rem 0}
.empty{border:1px dashed var(--line-2);border-radius:var(--rs);padding:1.4rem 1rem;text-align:center;color:var(--mut);font-size:var(--fs-s)}

/* ---- 9. start here: a real checklist, prose kept behind a toggle ---- */
.guide-close{position:absolute;top:.9rem;right:.9rem}
.card.guide{position:relative}
.cklist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.5rem}
.ck{display:flex;gap:.6rem;align-items:flex-start;background:var(--card-2);border:1px solid var(--line);border-radius:var(--rs);padding:.65rem .75rem}
.ck-t{flex:0 0 auto;font-size:var(--fs-m);line-height:1.45;color:var(--mut)}
.ck.on .ck-t{color:var(--ok)}
.ck.need .ck-t,.ck.need b{color:var(--warn)}
.ck b{font-size:var(--fs-s);font-weight:600;color:var(--silver)}
.ck .ck-s{display:block;font-size:var(--fs-xs);color:var(--mut);margin-top:.15rem}
.guide-more{margin-top:.8rem;border-top:1px solid var(--line);padding-top:.7rem}
.guide-more>summary{font-size:var(--fs-s)}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:.8rem;margin-top:.8rem}
.step{background:var(--card-2);border:1px solid var(--line);border-radius:var(--rs);padding:.85rem .9rem}
.step h3{font-size:var(--fs-s);font-weight:600;display:flex;align-items:center}
.step p{font-size:var(--fs-s);color:var(--silver);margin-top:.35rem}
.step p+p{margin-top:.4rem}
.step ul{margin:.4rem 0 0;padding-left:1.05rem;font-size:var(--fs-s);color:var(--silver)}
.step li{margin:.2rem 0}
.step li b{color:var(--ink);font-weight:600}
.guide-legend{margin-top:.5rem;display:flex;flex-direction:column;gap:.3rem}
.guide-legend .row{display:flex;gap:.45rem;align-items:flex-start;font-size:var(--fs-s);color:var(--silver)}
.guide-foot{margin-top:.9rem;font-size:var(--fs-xs);color:var(--mut)}

/* ---- 10. footer ---- */
footer{margin-top:1.4rem;padding-top:1.1rem;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:.6rem 1.5rem;align-items:flex-start;justify-content:space-between}
footer .fine{font-size:var(--fs-xs);color:var(--mut);max-width:44rem}
footer summary{color:var(--mut);margin-top:.5rem}
footer .dev{font-size:var(--fs-xs);color:var(--mut);margin-top:.35rem}

@media (max-width:560px){
  body{padding:0 .75rem 2.5rem}
  .masthead{padding:1.25rem 0 .9rem}
  .flowline{margin-left:0;text-align:left;width:100%}
  :root{--pad:.9rem;--fs-xl:1.3rem}
  .card{border-radius:12px}
  .hero{gap:.75rem}
  .hero-face{width:2.1rem;height:2.1rem;border-radius:9px;font-size:.85rem}
  .hero-t{font-size:var(--fs-l)}
  .hero-side{border-left:0;padding-left:0;width:100%;border-top:1px solid var(--line);padding-top:.6rem;text-align:left}
  .hero-side .s{max-width:none;margin-left:0}
  .rail .r{justify-content:flex-start}
  /* one address per row: it is the only way to tell inboxes apart */
  .tiles{grid-template-columns:1fr}
  .tile .t-name{white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere}
  .mgrid{grid-template-columns:1fr 1fr}
  .act-btns button,.field button{flex:1 1 auto}
  table{font-size:var(--fs-xs)}
  td.id{display:none}
  /* keep the answer, the warning and the fix together, then the detail */
  #fix{display:block}
  #hero{order:0}
  #alerts{order:1}
  #fix{order:2}
  #pipe{order:3}
  #nums{order:4}
  #log{order:5}
  #act{order:6}
  #guide{order:7}
}
@media (max-width:380px){
  .mgrid{grid-template-columns:1fr}
}
/* thumb-sized targets on anything you tap */
@media (pointer:coarse){
  summary{min-height:44px;display:flex;align-items:center;gap:.4rem;padding:.35rem 0;list-style:none}
  summary::before{content:"\\25B8";color:var(--mut);font-size:.8em}
  details[open]>summary::before{content:"\\25BE"}
  button{min-height:44px;display:inline-flex;align-items:center;justify-content:center;padding:.5rem 1rem}
  input[type=text],input[type=password]{min-height:44px}
  .ticker,.guide-foot,.legend{padding-bottom:.35rem}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}
  .conduit.live .pkt{animation:none}
  button:hover:not(:disabled),.tile:hover{transform:none}
  /* the 800ms tile flash is a status, so the "just now" chip and ring stay instead */
  .tile.flash{background:var(--card);border-color:var(--line)}
}
@media print{.hero-side,.act,.guide-close,#fix{display:none}}
</style>
</head>
<body>
<a class="vh" href="#main">Skip to the main content</a>
<div class="wrap">

<header class="masthead">
  <div class="brand">
    <h1><span class="mark" aria-hidden="true">&#9679;</span> sinka</h1>
    <p class="tagline">One inbox in, many team inboxes out.</p>
  </div>
  <p class="flowline">Reading <code>${escHtml(cfg.gmailUser)}</code> &rarr; filling <b>${cfg.forwardList.length}</b> team inbox${cfg.forwardList.length === 1 ? '' : 'es'}</p>
  <div class="badges">
    <span class="badge">Copies, not forwards</span>
    <span class="badge" id="b-sinks">Team inboxes set up: ${cfg.sinks.length}</span>
    ${cfg.dryRun ? '<span class="badge warn">Practice mode &middot; nothing is really copied</span>' : ''}
  </div>
</header>

<main id="main" class="stack">

  <section class="card hero" id="hero" aria-labelledby="hero-h">
    <h2 class="vh" id="hero-h">Is it working?</h2>
    <span class="hero-face" id="hero-face" aria-hidden="true">&#9679;</span>
    <div class="hero-body">
      <div role="status" aria-live="polite">
        <p class="hero-t" id="hero-t">Starting up&hellip;</p>
        <p class="hero-s" id="hero-s">Asking the server for the first numbers. Nothing here is a guess.</p>
      </div>
      <p class="hero-back" id="hero-back" role="status" hidden></p>
      <a class="hero-new" id="hero-guide" href="#guide">First time here? Read the 20-second guide</a>
    </div>
    <div class="hero-side">
      <p class="k">This page updates in</p>
      <p class="v"><span id="cd">30</span><span class="u" id="cd-u">s</span></p>
      <p class="s" id="cd-note">Redraws these numbers only. sinka checks mail on its own timer.</p>
      <div class="rail">
        <p class="r"><span class="k">Last check finished</span> <b id="c-rail-last">&mdash;</b></p>
        <p class="r"><span class="k">sinka checks mail every</span> <b id="c-rail-int">&mdash;</b></p>
        <p class="r"><span class="k">Numbers here are</span> <b id="c-rail-age">&mdash;</b></p>
      </div>
    </div>
  </section>

  <div class="alerts" id="alerts" role="status" aria-live="polite"></div>

  <section class="card fix" id="fix" aria-labelledby="fix-h">
    <h2 class="vh" id="fix-h">Fix it here</h2>
    <p class="fix-t" id="fix-what">Checking whether anything needs fixing&hellip;</p>
    <div class="act-btns">
      <button type="button" id="btn-test-fix">Send a test copy</button>
      <button type="button" class="ghost" id="btn-poll-fix">Check for mail now</button>
    </div>
  </section>

  <section class="card" id="pipe" aria-labelledby="pipe-h">
    <div class="sec-head">
      <h2 id="pipe-h">What it is doing right now</h2>
      <p class="sec-aside" id="d-count">waiting for the first answer</p>
    </div>
    <div class="pipe">
      <div class="srcrow">
        <span class="srcdot" id="srcdot" aria-hidden="true"></span>
        <span class="k">Reading from</span>
        <span class="v">${escHtml(cfg.gmailUser)}</span>
        <span class="state" id="pipe-state">checking for the first time</span>
      </div>
      <div class="conduit" id="conduit" title="New mail travels from the source inbox into every team inbox below"><span class="pkt"></span></div>
      <div class="dests" id="dests">${destHtml}</div>
    </div>
    <ul class="legend">
      <li><i class="sw sw-ok" aria-hidden="true"></i>Green &mdash; copying right now</li>
      <li><i class="sw sw-warn" aria-hidden="true"></i>Amber &mdash; no sign-in details yet, needs you</li>
      <li><i class="sw sw-err" aria-hidden="true"></i>Red &mdash; sign-in was refused</li>
      <li><i class="sw sw-lav" aria-hidden="true"></i>Purple &mdash; queued, trying again on the next check</li>
      <li><i class="sw sw-off" aria-hidden="true"></i>Gray &mdash; paused on purpose</li>
      <li><i class="sw sw-dot" aria-hidden="true"></i>Dot: green means the last check finished, red means it failed, gray means this page cannot reach sinka</li>
    </ul>
  </section>

  <section class="card" id="nums" aria-labelledby="nums-h">
    <div class="sec-head">
      <h2 id="nums-h">What the last check found</h2>
      <p class="sec-sub" id="upd"></p>
    </div>
    <div class="mgrid">
      <div class="metric"><div class="k">Last check</div><div class="v word" id="c-last">&mdash;</div><div class="s" id="c-last-s"></div></div>
      <div class="metric"><div class="k">New mail found</div><div class="v" id="c-fetched">&mdash;</div><div class="s">waiting in the source inbox</div></div>
      <div class="metric" data-metric="repl"><div class="k">Copies filed</div><div class="v" id="c-repl">&mdash;</div><div class="s">landed in your team inboxes</div></div>
      <div class="metric"><div class="k">Skipped</div><div class="v" id="c-skip">&mdash;</div><div class="s">already filed, or automatic replies</div></div>
      <div class="metric"><div class="k">Remembered</div><div class="v" id="c-seen">&mdash;</div><div class="s">messages sinka will never copy twice</div></div>
      <div class="metric"><div class="k">Checks every</div><div class="v word" id="c-int">&mdash;</div><div class="s" id="c-up"></div></div>
    </div>
    <p class="ticker">Counts fill in as copies are really delivered &mdash; nothing on this page is estimated.</p>
    <p class="frozen-note" id="frozen-note" hidden>These numbers stopped moving when this page lost the server. They are the last ones that really arrived.</p>
  </section>

  <section class="card" id="act" aria-labelledby="act-h">
    <div class="sec-head">
      <h2 id="act-h">Things you can do</h2>
      <p class="sec-sub">Everyday actions first. The one that cannot be undone is kept separate.</p>
    </div>

    <div class="actlist">
    <div class="act">
      <h3><span class="step-n" aria-hidden="true">1</span>Sign in, if you were given a private token</h3>
      <p>Some installs sit behind an extra sign-in. Paste the private token for this dashboard and the buttons below start working. It is kept in this tab only, never written to disk.</p>
      <div class="field">
        <label for="inp-token">Private token for this dashboard</label>
        <input type="password" id="inp-token" autocomplete="off" spellcheck="false" placeholder="Paste your private token">
      </div>
    </div>

    <div class="act">
      <h3><span class="step-n" aria-hidden="true">2</span>Everyday actions &mdash; nothing is lost</h3>
      <div class="act-btns">
        <button type="button" id="btn-poll">Check for mail now</button>
        <button type="button" class="ghost" id="btn-refresh">Refresh the numbers</button>
        <button type="button" class="ghost" id="btn-test">Send a test copy</button>
      </div>
      <div class="field">
        <label for="inp-to">Which inbox should the test copy go to?</label>
        <input type="text" id="inp-to" spellcheck="false" autocomplete="off" value="${escHtml(cfg.forwardList[0] || '')}" placeholder="team@example.com">
      </div>
      <p>&ldquo;Check for mail now&rdquo; looks straight away instead of waiting. &ldquo;Send a test copy&rdquo; puts one clearly labelled test message in every active inbox &mdash; the quickest way to prove a repaired password works.</p>
    </div>

    <div class="act care">
      <h3><span class="chip">Careful</span>This one cannot be undone</h3>
      <div class="act-btns">
        <button type="button" class="care" id="btn-base">Skip the backlog</button>
      </div>
      <p>&ldquo;Skip the backlog&rdquo; marks everything currently unread in the source inbox as read and copies none of it. Use it once, after a holiday or a flood, so the pile you never wanted is not copied into every team inbox. It asks you to confirm first.</p>
    </div>

    <div id="result" role="status" aria-live="polite" tabindex="-1" aria-busy="false" hidden>
      <p class="r-out" id="result-out"></p>
      <p class="r-meta" id="result-meta" hidden></p>
      <details class="r-raw" id="result-raw" hidden>
        <summary>Show the raw reply from the server (for whoever runs this)</summary>
        <pre id="result-json" tabindex="0"></pre>
      </details>
    </div>
    </div>
  </section>

  <section class="card" id="log" aria-labelledby="latest-h">
    <div class="sec-head">
      <h2 id="latest-h">What just happened</h2>
      <p class="sec-sub">The messages from the most recent check, newest first.</p>
    </div>
    <div class="latest" id="details">
      <p class="empty">Nothing was copied in the last check. New mail shows up here the moment it arrives.</p>
    </div>
  </section>

  <section class="card guide" id="guide" aria-labelledby="guide-h">
    <div class="sec-head">
      <h2 id="guide-h">Start here</h2>
      <button type="button" class="ghost guide-close" id="guide-close">Got it, hide this</button>
    </div>
    <p class="sec-sub">Three things in order. These tick themselves as sinka really gets going.</p>
    <ol class="cklist" id="steps">
      <li class="ck off" id="step-1"><span class="ck-t" aria-hidden="true">&#9675;</span><div><b>sinka is signed in to the source inbox</b><span class="vh"> &mdash; not done yet. </span><span class="ck-s">This page has not heard from sinka yet, so it cannot say.</span></div></li>
      <li class="ck off" id="step-2"><span class="ck-t" aria-hidden="true">&#9675;</span><div><b>Team inboxes can sign in</b><span class="vh"> &mdash; not done yet. </span><span class="ck-s">This page has not heard from sinka yet, so it cannot say.</span></div></li>
      <li class="ck off" id="step-3"><span class="ck-t" aria-hidden="true">&#9675;</span><div><b>A copy has really landed</b><span class="vh"> &mdash; not done yet. </span><span class="ck-s">This page has not heard from sinka yet, so it cannot say.</span></div></li>
    </ol>
    <details class="guide-more">
      <summary>Read the longer guide</summary>
      <div class="steps">
        <div class="step">
          <h3><span class="step-n" aria-hidden="true">1</span>What sinka does</h3>
          <p>sinka keeps many team inboxes in step. It reads new messages from one inbox you control and files a <b>copy</b> of each one into every team inbox you listed.</p>
          <p>The original stays where it is, and nothing is sent anywhere else on your behalf. Each copy arrives as an ordinary message, so replies, history and rules all work as your team expects.</p>
        </div>
        <div class="step">
          <h3><span class="step-n" aria-hidden="true">2</span>What the colors mean</h3>
          <div class="guide-legend">
            <span class="row"><i class="sw sw-ok" aria-hidden="true"></i><span><b>Green</b> &mdash; copying right now.</span></span>
            <span class="row"><i class="sw sw-warn" aria-hidden="true"></i><span><b>Amber</b> &mdash; no sign-in details yet, needs you.</span></span>
            <span class="row"><i class="sw sw-err" aria-hidden="true"></i><span><b>Red</b> &mdash; sign-in was refused.</span></span>
            <span class="row"><i class="sw sw-lav" aria-hidden="true"></i><span><b>Purple</b> &mdash; queued, trying again on the next check.</span></span>
            <span class="row"><i class="sw sw-off" aria-hidden="true"></i><span><b>Gray</b> &mdash; paused on purpose.</span></span>
            <span class="row"><i class="sw sw-dot" aria-hidden="true"></i><span><b>Dot</b> &mdash; green means the last check finished, red means it failed, gray means this page cannot reach sinka.</span></span>
          </div>
        </div>
        <div class="step">
          <h3><span class="step-n" aria-hidden="true">3</span>What each button does</h3>
          <ul>
            <li><b>Check for mail now</b> &mdash; look for new mail straight away instead of waiting for the timer.</li>
            <li><b>Refresh the numbers</b> &mdash; redraw this page with the newest information.</li>
            <li><b>Send a test copy</b> &mdash; send one labelled test message to every active inbox, to prove a fixed sign-in works.</li>
            <li><b>Skip the backlog</b> &mdash; mark everything currently unread as read and copy none of it. Asks you to confirm.</li>
          </ul>
        </div>
      </div>
      <p class="guide-foot">&ldquo;This page updates in&rdquo; is only the countdown on this page. sinka checks the mail itself on its own timer, shown as &ldquo;Checks every&rdquo; above. Reopen this guide any time with the <b>Guide</b> button in the footer.</p>
    </details>
    <p class="guide-foot" id="guide-foot">Reopen this guide any time with the <b>Guide</b> button in the footer. Numbers here are never invented: a tile shows 0 until a copy really lands.</p>
  </section>

</main>

<footer>
  <div class="fine">
    <p>This page is private. Only <code>${escHtml(cfg.gmailUser)}</code> is meant to see it, so do not share the address it is served from.</p>
    <details>
      <summary>Details for whoever runs this</summary>
      <div class="dev">
        <p>sinka reads one inbox and files copies into each inbox listed in the server settings (<code>DEST_SINKS</code>, <code>FORWARD_LIST</code>). Entries prefixed with <code>-</code> are kept but paused. A shared <code>ADMIN_TOKEN</code> gates this page behind a private token that the browser holds in memory only.</p>
        <p>Copying uses IMAP <code>APPEND</code> into each team inbox. There is no sending path. If this page is not behind Cloudflare Access (email one-time code), do not expose the port publicly.</p>
        <p>The countdown at the top is this page's own redraw timer, nothing more. The real interval between mail checks is <code>POLL_INTERVAL_MS</code>, shown as &ldquo;Checks every&rdquo;.</p>
        <p>Machine-readable status: <code>GET /api/status</code> &middot; <code>POST /api/poll-now</code> &middot; <code>POST /api/baseline</code> &middot; <code>POST /api/test-forward</code> &middot; <code>GET /healthz</code></p>
      </div>
    </details>
  </div>
  <div>
    <button type="button" class="ghost" id="guide-open">Guide</button>
  </div>
</footer>

</div>
<script>
var token='';
var GUIDE_KEY='sinka.guide.hidden.v1';
var REFRESH_SECS=30;
var netDownAt=0;      // when this page first noticed it could not reach the server
var lastGood=null;    // the last payload that really arrived
var lastGoodAt=0;     // when it arrived
var flashAt={};       // inbox -> time of a real copy, the still signal under reduced motion
var lastVerdict='';   // so an unchanged answer is not read out again every 30s
var lastAlertHtml=''; // so the alerts are only announced when they really change
var countdown=REFRESH_SECS;
var hiddenSince=0;
var backTimer=null;
var BUTTONS=['btn-poll','btn-base','btn-test','btn-refresh','btn-test-fix','btn-poll-fix'];
function h(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function el(id){return document.getElementById(id);}
/* Only write when the words really change: a live region must not repeat itself. */
function setText(id,v){var n=el(id);if(!n)return;v=String(v==null?'':v);if(n.textContent!==v)n.textContent=v;}
function rel(iso){if(!iso)return'\u2014';var t=new Date(iso).getTime();if(isNaN(t))return'\u2014';var d=Date.now()-t;if(d<0)return'just now';if(d<45e3)return'just now';if(d<3600e3)return Math.round(d/60e3)+' min ago';if(d<86400e3)return Math.round(d/3600e3)+' h ago';return new Date(iso).toLocaleString();}
function ageText(ms){if(ms==null)return'\u2014';var s=Math.round(ms/1000);if(s<5)return'just now';if(s<90)return s+'s old';if(s<5400)return Math.round(s/60)+' min old';if(s<172800)return Math.round(s/3600)+' h old';return Math.round(s/86400)+' days old';}
function humanMs(ms){if(ms==null)return'\u2014';var s=Math.round(ms/1000);if(s<60)return s+'s';return (ms/60000).toFixed(ms<600000?1:0)+'m';}
function reduced(){try{return window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;}catch(e){return false;}}
function api(path,body){var hd={'Content-Type':'application/json'};if(token)hd['Authorization']='Bearer '+token;
 return fetch(path,{method:body?'POST':'GET',headers:hd,body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().then(function(j){j._http=r.status;return j;}).catch(function(){return {_http:r.status,success:false,error:'The server sent back something unreadable (status '+r.status+').'};});});}
function setFrozen(on){var b=document.body;if(b&&b.classList)b.classList.toggle('frozen',!!on);
 var f=el('frozen-note');if(f)f.hidden=!on;}

/* ---- results in plain words; the raw reply stays available but folded away ---- */
function uniqReasons(fails){var seen={},out=[];for(var i=0;i<fails.length;i++){var r=String((fails[i]&&fails[i].error)||'no reason given');if(seen[r])continue;seen[r]=1;out.push(r);}return out;}
function outcome(o,ctx){
 if(!o||typeof o!=='object')return'The server did not send back an answer at all.';
 if(o.busy)return'A check was already running, so nothing was started a second time.';
 if(o._http&&o._http>=400&&!o.error)return'The server answered with status '+o._http+' instead of doing the job.';
 if(o.error){var lead=ctx==='test'?'The test copy was not filed. ':(ctx==='base'?'The backlog was not skipped. ':(ctx==='poll'?'The check did not finish. ':'That did not work. '));return lead+String(o.error);}
 if(ctx==='test'&&o.dryRun)return'Practice mode, so nothing was really sent. sinka worked out that the test copy would go to '+(o.to||'the first inbox')+'.';
 if(Array.isArray(o.results)){
  var ok=0,fails=[];o.results.forEach(function(x){if(x&&x.ok)ok++;else fails.push(x);});
  var n=o.results.length,head='Filed one test copy into '+n+' inbox'+(n===1?'':'es')+': '+ok+' accepted';
  if(!fails.length)return head+', none refused.';
  return head+', '+fails.length+' failed: '+uniqReasons(fails).join('; ')+'.';}
 if(o.baselined!=null)return'Marked '+o.baselined+' message'+(o.baselined===1?'':'s')+' as read and copied none of them. sinka carries on with whatever arrives next.';
 if(o.fetched!=null){
  var f=o.fetched||0;
  if(!f)return'Looked in the source inbox just now. There was no new mail to copy.';
  var parts=['Found '+f+' new message'+(f===1?'':'s')];
  if(o.replicated!=null)parts.push('filed '+(o.replicated||0)+' cop'+(o.replicated===1?'y':'ies'));
  if(o.retried)parts.push('retried '+(o.retried===1?'1 copy':o.retried+' copies'));
  if(o.skipped)parts.push('skipped '+(o.skipped));
  if(o.pending)parts.push(o.pending+' still queued for the next check');
  return parts.join(', ')+'.';}
 if(o.replicated!=null)return'Filed '+(o.replicated||0)+' cop'+(o.replicated===1?'y':'ies')+'.';
 return'The server accepted that and said nothing more.';}
function showMsg(o,ctx){var box=el('result');if(!box)return;box.hidden=false;
 setText('result-out',outcome(o,ctx));
 var meta=el('result-meta');if(meta){meta.textContent='';meta.hidden=true;}
 var det=el('result-raw'),pre=el('result-json');
 if(det&&pre){var raw;try{raw=JSON.stringify(o==null?{error:'No answer from the server.'}:o,null,2);}catch(e){raw=String(o);}pre.textContent=raw;det.hidden=false;det.open=false;}}
function focusResult(){var r=el('result');if(!r)return;r.hidden=false;try{r.focus({preventScroll:false});}catch(e){try{r.focus();}catch(e2){/* nothing focusable, the text is still there */}}}
/* A ten-inbox test must not look like nothing happened. */
function setBusy(b,btn,label){var r=el('result');if(r)r.setAttribute('aria-busy',b?'true':'false');
 for(var i=0;i<BUTTONS.length;i++){var n=el(BUTTONS[i]);if(n)n.disabled=!!b;}
 if(btn){if(b){if(btn.getAttribute('data-orig')===null)btn.setAttribute('data-orig',btn.textContent);if(label)btn.textContent=label;btn.setAttribute('aria-busy','true');}
  else{var o=btn.getAttribute('data-orig');if(o!==null){btn.textContent=o;btn.removeAttribute('data-orig');}btn.removeAttribute('aria-busy');}}}
function runAction(btn,label,ctx,fn,thenRefresh){
 setBusy(true,btn,label);
 var p;try{p=Promise.resolve(fn());}catch(e){p=Promise.reject(e);}
 return p.then(function(o){showMsg(o,ctx);return thenRefresh?refresh():null;})
  .catch(function(e){showMsg({success:false,error:String(e&&e.message?e.message:e)},ctx);})
  .then(function(){setBusy(false,btn);focusResult();});}

/* ---- "Start here" guide: shown until it is dismissed, then reopenable from the footer ---- */
function guideHidden(){try{return localStorage.getItem(GUIDE_KEY)==='1';}catch(e){return false;}}
function setGuide(show){var g=el('guide'),b=el('guide-close');if(g)g.hidden=!show;if(b)b.hidden=!show;try{if(show)localStorage.removeItem(GUIDE_KEY);else localStorage.setItem(GUIDE_KEY,'1');}catch(e){/* private mode: just keep it for this page view */}}
function openGuide(){setGuide(true);var g=el('guide');if(g&&g.scrollIntoView){try{g.scrollIntoView({block:'center',behavior:reduced()?'auto':'smooth'});}catch(e){g.scrollIntoView();}}}

/* ---- per-inbox copy counters driving the tile counts and sparklines ---- */
var stats={};
function statHits(user){var s=stats[user]||(stats[user]={total:0,hits:[]});var cut=Date.now()-60000;s.hits=s.hits.filter(function(t){return t>cut;});return s;}
function justNow(user){return !!(flashAt[user]&&(Date.now()-flashAt[user])<90000);}
function sparkHtml(user){var s=statHits(user);var out='';for(var i=0;i<12;i++){var t0=Date.now()-(12-i)*5000,t1=t0+5000,n=0;for(var j=0;j<s.hits.length;j++){if(s.hits[j]>=t0&&s.hits[j]<t1)n++;}out+='<i'+(n?' class="hot"':'')+' style="height:'+Math.min(16,2+n*4)+'px"></i>';}return out;}
function tileHtml(a,cls,count,unit,note,jn){
 var j=!!jn;return '<div class="tile '+cls+(j?' jn':'')+'" data-user="'+h(a)+'" title="'+h(a)+'">'
  +'<div class="t-name">'+h(a)+'</div>'
  +'<div class="t-foot"><span class="t-count">'+count+'</span><span class="t-unit">'+h(unit)+'</span></div>'
  +((note||j)?'<div class="t-note'+(j?' jn':'')+'">'+(j?'copied just now':h(note))+'</div>':'')
  +'<div class="spark">'+sparkHtml(a)+'</div></div>';}
function renderDests(d){
// Group labels here are the source of truth; the server's first paint mirrors them.
 var list=d.destinations||[],on=d.sinkUsers||[],off=d.disabledSinks||[],auto=d.autoDisabledSinks||[];
 var pending=(Array.isArray(d.pendingSinks)?d.pendingSinks:[]).filter(function(p){return p&&p.to;});
 var onS={},offS={},autoS={};on.forEach(function(a){onS[a]=1;});off.forEach(function(a){offS[a]=1;});auto.forEach(function(a){autoS[a]=1;});
 function grp(title,arr,cls){if(!arr.length)return '';return '<div class="grp"><span class="grp-k">'+h(title)+'</span><span class="grp-n">'+arr.length+'</span></div><div class="tiles">'+arr.map(function(a){return tileHtml(a,cls,statHits(a).total,'copies','',justNow(a));}).join('')+'</div>';}
 function retryGrp(){
  if(!pending.length)return '';
  var tiles=pending.map(function(p){var n=Number(p.attempts)||0;return tileHtml(p.to,'retry',n,n===1?'try':'tries','Waiting for the next check',false);}).join('');
  return '<div class="grp retry"><span class="grp-k">Trying again</span><span class="grp-n">'+pending.length+'</span></div><div class="tiles">'+tiles+'</div>'
   +'<p class="pipe-foot">'+pending.length+' cop'+(pending.length===1?'y':'ies')+' could not be filed yet, so sinka keeps them queued and retries on the next check.</p>';}
 var node=el('dests');if(!node)return;
 node.innerHTML=grp('Copying right now',list.filter(function(a){return onS[a]&&!autoS[a];}),'on')
  +grp('Sign-in failed, waiting for you',list.filter(function(a){return autoS[a];}),'auto')
  +grp('Paused by you',list.filter(function(a){return offS[a];}),'off')
  +grp('No sign-in details yet',list.filter(function(a){return !onS[a]&&!offS[a];}),'miss')
  +retryGrp()
  +'<p class="pipe-foot">Nothing is copied to a tile until a copy really lands, so every count starts at zero.</p>';
 var working=list.filter(function(a){return onS[a]&&!autoS[a];}).length;
 setText('d-count',list.length?(working+' of '+list.length+' inboxes copying right now'):'No team inboxes listed yet');
}
function renderDetails(r){
 var node=el('details');if(!node)return;
 if(!r.details||!r.details.length){node.innerHTML='<p class="empty">Nothing was copied in the last check. New mail shows up here the moment it arrives.</p>';return;}
 var rows=r.details.map(function(m){
  var res=m.results||[],ok=res.filter(function(x){return x.ok;}).length;
  var per=res.map(function(x){var verdict=x.ok?('filed'+(x.via?' ('+x.via+')':'')):(x.skipped?'skipped: '+x.skipped:'not filed: '+(x.error||'unknown reason'));return '<li>'+h(x.to)+' &mdash; '+h(verdict)+'</li>';}).join('');
  return '<tr><td class="id"><code>'+h(String(m.messageId||'').slice(0,28))+'</code></td>'
   +'<td><span class="subj">'+h(m.subject||'(no subject)')+'</span><span class="fr">from '+h(m.from||'an unknown sender')+'</span></td>'
   +'<td><details><summary>'+ok+' of '+res.length+' filed</summary><ul>'+per+'</ul></details></td></tr>';
 }).join('');
 node.innerHTML='<table><caption class="vh">Messages from the most recent check</caption><thead><tr><th scope="col">Reference</th><th scope="col">Message</th><th scope="col">Copies</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
function renderHero(d,r){
 var hero=el('hero'),face=el('hero-face'),t=el('hero-t'),s=el('hero-s');
 if(!hero||!face||!t||!s)return;
 var cls='ok',symbol='\u25cf',line='Everything is working',sub='New mail is being copied into your team inboxes.';
 if(d.setupNeeded){cls='err';symbol='\u2715';line='One more step needed';sub='sinka cannot copy anything until its own sign-in details are set. The details are below.';}
 else if(r.error){cls='err';symbol='\u2715';line='The last check did not finish';sub='sinka is waiting and trying again on its own, a little longer each time. The details are below.';}
 else if(d.autoDisabledSinks&&d.autoDisabledSinks.length){cls='warn';symbol='\u25d0';line=(d.autoDisabledSinks.length===1?'1 inbox needs':' '+d.autoDisabledSinks.length+' inboxes need')+' your help';sub='A sign-in was refused. Fix it, then choose Send a test copy.';}
 else if(!d.sinksConfigured){cls='warn';symbol='\u25d0';line='No team inboxes yet';sub='Add at least one team inbox in the server settings, then send a test copy to check it.';}
 else if(!d.lastPollAt){cls='warn';symbol='\u25cc';line='Starting up';sub='The first check runs in a few seconds.';}
 else if(humanMs(d.pollIntervalMs)==='\u2014'){cls='warn';symbol='\u25cc';line='Waiting for the first check';sub='This page cannot see how often checks run yet.';}
 var none=!(d.destinations&&d.destinations.length);
 var tail=(none&&!/team inbox/i.test(sub))?' There are no team inboxes listed yet.':'';
 var key=cls+'|'+line;                       // verdict changes are announced, repeats are not
 if(key!==lastVerdict){lastVerdict=key;face.textContent=symbol;t.textContent=line;}
 hero.className='card hero '+cls;
 setText('hero-s',sub+tail);
}
function renderAlerts(al){var an=el('alerts');if(!an)return;var html=al.join('');
 if(html===lastAlertHtml)return;              // announce the alert set only when it really changes
 lastAlertHtml=html;an.innerHTML=html;}
function ck(n,on,need,title,sub){
 return '<li class="ck'+(on?' on':' off')+(need?' need':'')+'" id="step-'+n+'">'
  +'<span class="ck-t" aria-hidden="true">'+(on?'\u2713':'\u25cb')+'</span>'
  +'<div><b>'+h(title)+'</b><span class="vh"> &mdash; '+(on?'done':'not done yet')+'. </span>'
  +'<span class="ck-s">'+h(sub)+'</span></div></li>';}
/* The checklist only ever states what is really true, so a healthy install sees three ticks.
   With no answer from sinka it says so instead of guessing or staying blank. */
var STEP_TITLES=['sinka is signed in to the source inbox','Team inboxes can sign in','A copy has really landed'];
function renderSteps(d,r,unknown){
 var box=el('steps');if(!box)return;
 if(unknown){box.innerHTML=[0,1,2].map(function(i){return ck(i+1,false,false,STEP_TITLES[i],unknown);}).join('');return;}
 var dests=(d.destinations||[]).length;
 var have=typeof d.sinksConfigured==='number'?d.sinksConfigured:(Array.isArray(d.sinkUsers)?d.sinkUsers.length:0);
 var refused=(d.autoDisabledSinks||[]).length;
 var filed=(r.replicated||0)+(r.retried||0),ev=0;
 if(Array.isArray(r.details))r.details.forEach(function(m){(m.results||[]).forEach(function(x){if(x&&x.ok)ev++;});});
 var rows=[];
 rows.push(ck(1,!d.setupNeeded,!!d.setupNeeded,
  d.setupNeeded?'sinka is not signed in yet':'sinka is signed in to the source inbox',
  d.setupNeeded?'Fill in sinka\'s own sign-in details in the server settings. Until then it cannot read the source inbox.':'sinka can read the source inbox, so it is ready to copy.'));
 var missN=dests-have;
 rows.push(ck(2,dests>0&&missN<=0&&!refused,dests===0||missN>0||refused>0,
  dests?(have+' of '+dests+' inboxes can sign in'):'No team inboxes listed yet',
  !dests?'Add at least one team inbox in the server settings, then send a test copy.'
  :(refused?refused+' sign-in'+(refused===1?' was':'s were')+' refused, so copying is paused there. Fix the password, then choose Send a test copy.'
  :(missN>0?missN+' inbox'+(missN===1?' has':'es have')+' no sign-in details yet.':'Every listed inbox is ready to receive copies.'))));
 var seen=Number(d.seenCount)||0,landed=(seen>0)||filed>0||ev>0;
 rows.push(ck(3,landed,false,
  landed?'A copy has really landed':'No copy delivered yet',
  landed?'At least one message was filed into a team inbox, so the copying works end to end.'
  :'Nothing has come in to the source inbox yet, so there is nothing to copy. This is normal until mail arrives.'));
 box.innerHTML=rows.join('');
}
function renderFix(d,r){
 var w=el('fix-what');if(!w)return;var line;
 if(d.setupNeeded)line='sinka\'s own sign-in details are missing. Fill them in on the server, then come back and send a test copy.';
 else if((d.autoDisabledSinks||[]).length)line='A sign-in was refused for '+(d.autoDisabledSinks||[]).join(', ')+'. Fix the password on the server, then send a test copy to switch copying back on.';
 else if(!d.sinksConfigured)line='No team inbox is ready. Add one in the server settings, then send a test copy to check it.';
 else if((d.disabledSinks||[]).length)line='Nothing to fix. '+d.disabledSinks.length+' inbox'+(d.disabledSinks.length===1?' is':'es are')+' paused on purpose.';
 else if(d.consecutiveErrors)line='Nothing to fix. sinka is waiting longer between tries after a failed check.';
 else line='Nothing needs fixing right now. A test copy is the quickest way to prove copying works.';
 setText('fix-what',line);}
function render(d){
 d=d||{};
 var r=d.lastResult||{};
 setText('upd',d.lastPollAt?('Updated '+rel(d.lastPollAt)+'.'):'');
 setText('c-last',d.lastPollAt?rel(d.lastPollAt):'\u2014');
 setText('c-last-s',(r.reason||'')+(r.ms!=null?' \u00b7 took '+(r.ms/1000).toFixed(1)+'s':'')+(r.error?' \u00b7 did not finish':''));
 setText('c-fetched',r.fetched!=null?String(r.fetched):'\u2014');
 setText('c-repl',r.replicated!=null?String(r.replicated):'\u2014');
 setText('c-skip',r.skipped!=null?String(r.skipped):'\u2014');
 setText('c-seen',d.seenCount!=null?String(d.seenCount):'\u2014');
 setText('c-int',humanMs(d.pollIntervalMs));
 setText('c-up',d.startedAt?('this page has been open since '+new Date(d.startedAt).toLocaleTimeString()):'');
 setText('c-rail-last',d.lastPollAt?rel(d.lastPollAt):'\u2014');
 setText('c-rail-int',humanMs(d.pollIntervalMs));
 paintRail();
 setText('b-sinks','Team inboxes set up: '+(d.sinksConfigured!=null?d.sinksConfigured:'?'));
 var replBox=document.querySelector('[data-metric="repl"]');if(replBox)replBox.className='metric'+(r.replicated>0?' good':(r.replicated===0?' zero':''));
 // Note the real copies first, so a tile can carry a lasting "copied just now" mark
 // (the 800ms flash is motion, and motion is not allowed to be the only signal).
 if(Array.isArray(r.details)&&r.details.length){r.details.forEach(function(m){(m.results||[]).forEach(function(x){if(x.ok){var st=statHits(x.to);st.total++;st.hits.push(Date.now());flashAt[x.to]=Date.now();}});});}
 renderDests(d);
 if(Array.isArray(r.details)&&r.details.length&&!reduced()){var okUsers={};r.details.forEach(function(m){(m.results||[]).forEach(function(x){if(x.ok)okUsers[x.to]=1;});});
  var flashed=Object.keys(okUsers);if(flashed.length){var tiles=[];flashed.forEach(function(u){var t=document.querySelector('#dests .tile[data-user="'+String(u).replace(/"/g,'\\"')+'"]');if(t){t.classList.add('flash');tiles.push(t);}});setTimeout(function(){tiles.forEach(function(t){t.classList.remove('flash');});},800);}}
 if(r.fetched>0){var cd2=el('conduit');if(cd2){cd2.classList.add('live');setTimeout(function(){cd2.classList.remove('live');},2500);}}
 var dot=el('srcdot'),ps=el('pipe-state');
 if(dot){dot.classList.remove('dead');dot.classList.toggle('idle',!!(d.setupNeeded||r.error||d.consecutiveErrors>0));
  if(ps)ps.textContent=d.setupNeeded?'not set up yet':(r.error?'last check failed':'checking on its own');}
 renderHero(d,r);
 var al=[];
 if(d.setupNeeded)al.push('<div class="alert err"><b>One more step needed.</b> sinka cannot copy any mail until its own sign-in details are set. Details: <code>'+h(d.setupNeeded)+'</code></div>');
 if(!d.sinksConfigured)al.push('<div class="alert warn"><b>Nothing is being copied yet.</b> No team inbox is ready. Add one in the server settings, then choose Send a test copy to check it.</div>');
 if(d.disabledSinks&&d.disabledSinks.length)al.push('<div class="alert warn"><b>Paused on purpose.</b> '+d.disabledSinks.map(h).join(', ')+' will not receive copies until you take the leading dash off the address in the server settings.</div>');
 if(d.autoDisabledSinks&&d.autoDisabledSinks.length)al.push('<div class="alert err"><b>Sign-in was refused.</b> '+d.autoDisabledSinks.map(h).join(', ')+' &mdash; the password was rejected or revoked. Fix it, then choose Send a test copy to switch copying back on.</div>');
 if(r.error)al.push('<div class="alert err"><b>The last check did not finish</b> ('+h(r.reason||'automatic')+'): <code>'+h(r.error)+'</code></div>');
 if(d.consecutiveErrors)al.push('<div class="alert note"><b>Being patient.</b> '+d.consecutiveErrors+' check'+(d.consecutiveErrors===1?'':'s')+' in a row did not finish, so sinka is waiting longer between tries, up to an hour.</div>');
 if(!al.length&&!(d.destinations&&d.destinations.length))al.push('<div class="alert warn"><b>No team inboxes listed.</b> There is nowhere to put copies yet. Add at least one inbox in the server settings.</div>');
 renderAlerts(al);
 renderFix(d,r);
 renderSteps(d,r);
 renderDetails(r);
}
function paintRail(){setText('c-rail-age',lastGoodAt?ageText(Date.now()-lastGoodAt):'\u2014');}
function answeredAgo(){return lastGoodAt?ageText(Date.now()-lastGoodAt):'never';}
function noteBack(text){var n=el('hero-back');if(!n)return;n.textContent=text;n.hidden=false;
 if(backTimer)clearTimeout(backTimer);backTimer=setTimeout(function(){n.hidden=true;},8000);}
/* The server is gone. Say so, stop the numbers pretending to be live, keep retrying. */
function netDown(e){
 if(!netDownAt)netDownAt=Date.now();
 var why=String((e&&e.message)||e||'no answer');
 var hero=el('hero');
 if(hero)hero.className='card hero down';
 var t=el('hero-t'),s=el('hero-s'),face=el('hero-face');
 var line="Can't reach sinka \u2014 the numbers below may be out of date";
 var sub='This page cannot talk to sinka, so nothing below is moving: these are the numbers from the last time it answered. It keeps trying every '+REFRESH_SECS+' seconds.';
 if(t&&s&&t.textContent!==line){if(face)face.textContent='\u2715';t.textContent=line;s.textContent=sub;}
 lastVerdict='down';
 setFrozen(true);
 var dot=el('srcdot');if(dot){dot.classList.remove('idle');dot.classList.add('dead');}
 setText('pipe-state',lastGoodAt?('out of reach, numbers frozen'):'cannot reach sinka');
 setText('cd-note','Redraws these numbers only. Nothing new can arrive until sinka answers again.');
 setText('upd','These numbers stopped moving. Last answer from sinka: '+answeredAgo()+'.');
 setText('d-count','out of reach \u2014 not moving');
 setText('fix-what','sinka cannot be reached, so there is nothing this page can do until it answers again.');
 renderSteps(null,null,'sinka is out of reach, so this page cannot say yet. It keeps trying every '+REFRESH_SECS+' seconds.');
 renderAlerts(['<div class="alert err"><b>This page cannot reach sinka.</b> Everything below is the last thing that really arrived, and it is not changing until the server answers again. Details: <code>'+h(why)+'</code></div>']);
 paintRail();
}
function refresh(){
 return api('/api/status').then(function(d){
  var was=netDownAt;
  netDownAt=0;lastGood=d||{};lastGoodAt=Date.now();
  setFrozen(false);
  render(lastGood);
  countdown=REFRESH_SECS;setText('cd',countdown);
  if(was)noteBack('Reconnected \u2014 these numbers are live again.');
  return lastGood;})
 .catch(function(e){netDown(e);return null;});}
var guideClose=el('guide-close');if(guideClose)guideClose.onclick=function(){setGuide(false);};
var guideOpen=el('guide-open');if(guideOpen)guideOpen.onclick=function(){openGuide();};
var heroGuide=el('hero-guide');if(heroGuide)heroGuide.onclick=function(e){e.preventDefault();openGuide();};
var btnRefresh=el('btn-refresh');
if(btnRefresh)btnRefresh.onclick=function(){setBusy(true,btnRefresh,'Refreshing\u2026');refresh().then(function(){setBusy(false,btnRefresh);});};
var btnPoll=el('btn-poll');
if(btnPoll)btnPoll.onclick=function(){runAction(btnPoll,'Checking\u2026','poll',function(){return api('/api/poll-now');},true);};
var btnPollFix=el('btn-poll-fix');
if(btnPollFix)btnPollFix.onclick=function(){runAction(btnPollFix,'Checking\u2026','poll',function(){return api('/api/poll-now');},true);};
var btnTest=el('btn-test');
if(btnTest)btnTest.onclick=function(){var to=el('inp-to');runAction(btnTest,'Sending\u2026','test',function(){return api('/api/test-forward',{to:to?to.value:''});},false);};
var btnTestFix=el('btn-test-fix');
if(btnTestFix)btnTestFix.onclick=function(){var to=el('inp-to');runAction(btnTestFix,'Sending\u2026','test',function(){return api('/api/test-forward',{to:to?to.value:''});},false);};
var btnBase=el('btn-base');
if(btnBase)btnBase.onclick=function(){if(!confirm('Skip the backlog? This marks everything currently unread in the source inbox as read and copies none of it. It cannot be undone.'))return;
 runAction(btnBase,'Skipping\u2026','base',function(){return api('/api/baseline');},true);};
var inpToken=el('inp-token');if(inpToken)inpToken.oninput=function(e){token=e.target.value.trim();};
function tick(){
 paintRail();
 if(document.hidden)return;              // paused while the tab is in the background
 countdown--;
 if(countdown<=0){countdown=REFRESH_SECS;refresh();}
 setText('cd',countdown);}
document.addEventListener('visibilitychange',function(){
 if(document.hidden){hiddenSince=Date.now();setText('cd','paused');var u=el('cd-u');if(u)u.hidden=true;return;}
 var away=hiddenSince?Date.now()-hiddenSince:0;hiddenSince=0;
 var u2=el('cd-u');if(u2)u2.hidden=false;
 setText('cd-note','Redraws these numbers only. sinka checks mail on its own timer.');
 countdown=REFRESH_SECS;setText('cd',countdown);
 refresh().then(function(){if(away>45000&&!netDownAt)noteBack('Welcome back \u2014 updated just now.');});});
if(guideHidden())setGuide(false);
setText('cd',countdown);
refresh();setInterval(tick,1000);
</script>
</body>
</html>`);
});

app.get('/api/status', requireAdmin, (_req, res) => {
  res.json({
    success: true,
    setupNeeded,
    source: cfg.gmailUser,
    destinations: cfg.forwardList,
    sinksConfigured: cfg.sinks.filter((s) => s.enabled !== false).length,
    sinkUsers: cfg.sinks.filter((s) => s.enabled !== false).map((s) => s.user),
    disabledSinks: cfg.sinks.filter((s) => s.enabled === false).map((s) => s.user),
    autoDisabledSinks: getAutoDisabled(),
    pendingSinks: getPending(),
    pollIntervalMs: cfg.pollIntervalMs,
    dryRun: cfg.dryRun,
    seenCount: store.size(),
    ...state,
  });
});

app.post('/api/poll-now', requireAdmin, async (_req, res) => {
  const result = await poll('manual');
  if (result?.busy) return res.status(409).json({ success: false, busy: true, message: 'A poll is already running' });
  res.json({ success: !result.error, ...result });
});

// POST /api/baseline - mark all current UNSEEN as Seen without forwarding.
// Use after vacations/backlogs so only genuinely new mail gets replicated.
app.post('/api/baseline', requireAdmin, async (_req, res) => {
  try {
    if (setupNeeded) {
      return res.status(503).json({ success: false, error: setupNeeded });
    }
    const messages = await withTimeout(fetchNewMessages(cfg), IMAP_BUDGET_MS, 'fetchNewMessages');
    await withTimeout(markUidsSeen(cfg, messages.map((m) => m.uid)), IMAP_BUDGET_MS, 'baselineMark');
    res.json({ success: true, baselined: messages.length });
  } catch (err) {
    res.status(502).json({ success: false, error: err?.message || String(err) });
  }
});

app.post('/api/test-forward', requireAdmin, async (req, res) => {
  if (setupNeeded) {
    return res.status(503).json({ success: false, error: setupNeeded });
  }
  const target = String(req.body?.to || cfg.forwardList[0] || '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 254);
  try {
    const out = await appendTestMessage(cfg, target);
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(502).json({ success: false, error: err?.message || String(err) });
  }
});

if (runOnce) {
  await poll('once');
  process.exit(state.lastResult?.error ? 1 : 0);
} else {
  app.listen(cfg.port, () => {
    console.log(`sinka listening on :${cfg.port} (hostname sinka.example.com -> localhost:${cfg.port})`);
  });
  // Initial poll shortly after boot, then on interval. Overlaps are skipped
  // by awaiting; a slow poll simply delays the next tick.
  setTimeout(() => poll('boot'), 5000);
  setInterval(() => poll('timer'), cfg.pollIntervalMs);
}
