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
            headers: { Title: 'Sinka — mail copying is failing', Priority: 'high', Tags: 'warning' },
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
  // The address appears once as text and once as data-user for the tile lookup:
  // no title=, so a screen reader is not handed the same inbox three times.
  // The sparkline bars are decorative, so they are hidden from it.
  const tile = (a, cls) => `<div class="tile ${cls}" data-user="${escHtml(a)}"><div class="t-name">${escHtml(a)}</div><div class="t-foot"><span class="t-count">0</span><span class="t-unit">copies</span></div><div class="spark">${'<i aria-hidden="true"></i>'.repeat(12)}</div></div>`;
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
<meta name="description" content="Sinka dashboard: does mail copying work, what is it doing right now, and what needs fixing.">
<title>Sinka &middot; is mail copying?</title>
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
body.frozen .mgrid,body.frozen .dests,body.frozen #details,body.frozen .cklist,body.frozen .rail{opacity:.5;filter:saturate(.55)}

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
    <h1><span class="mark" aria-hidden="true">&#9679;</span> Sinka</h1>
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
      <p class="s" id="cd-note">Redraws these numbers only. Sinka checks mail on its own timer.</p>
      <div class="rail">
        <p class="r"><span class="k">Last check finished</span> <b id="c-rail-last">&mdash;</b></p>
        <p class="r"><span class="k">Sinka checks mail every</span> <b id="c-rail-int">&mdash;</b></p>
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
    <p class="fix-t" id="fix-to" style="margin-top:.5rem">Where the test copy will go is filled in once the server answers.</p>
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
      <li><i class="sw sw-dot" aria-hidden="true"></i>Dot: green means the last check finished, red means it failed, gray means this page cannot reach Sinka</li>
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
      <div class="metric"><div class="k">Remembered</div><div class="v" id="c-seen">&mdash;</div><div class="s">messages Sinka will never copy twice</div></div>
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
    <p class="sec-sub">Three things in order. These tick themselves as Sinka really gets going.</p>
    <ol class="cklist" id="steps">
      <li class="ck off" id="step-1"><span class="ck-t" aria-hidden="true">&#9675;</span><div><b>Sinka is signed in to the source inbox</b><span class="vh"> &mdash; not done yet. </span><span class="ck-s">This page has not heard from Sinka yet, so it cannot say.</span></div></li>
      <li class="ck off" id="step-2"><span class="ck-t" aria-hidden="true">&#9675;</span><div><b>Team inboxes can sign in</b><span class="vh"> &mdash; not done yet. </span><span class="ck-s">This page has not heard from Sinka yet, so it cannot say.</span></div></li>
      <li class="ck off" id="step-3"><span class="ck-t" aria-hidden="true">&#9675;</span><div><b>A copy has really landed</b><span class="vh"> &mdash; not done yet. </span><span class="ck-s">This page has not heard from Sinka yet, so it cannot say.</span></div></li>
    </ol>
    <details class="guide-more">
      <summary>Read the longer guide</summary>
      <div class="steps">
        <div class="step">
          <h3><span class="step-n" aria-hidden="true">1</span>What Sinka does</h3>
          <p>Sinka keeps many team inboxes in step. It reads new messages from one inbox you control and files a <b>copy</b> of each one into every team inbox you listed.</p>
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
            <span class="row"><i class="sw sw-dot" aria-hidden="true"></i><span><b>Dot</b> &mdash; green means the last check finished, red means it failed, gray means this page cannot reach Sinka.</span></span>
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
      <p class="guide-foot">&ldquo;This page updates in&rdquo; is only the countdown on this page. Sinka checks the mail itself on its own timer, shown as &ldquo;Checks every&rdquo; above. Reopen this guide any time with the <b>Guide</b> button in the footer.</p>
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
        <p>Sinka reads one inbox and files copies into each inbox listed in the server settings (<code>DEST_SINKS</code>, <code>FORWARD_LIST</code>). Entries prefixed with <code>-</code> are kept but paused. A shared <code>ADMIN_TOKEN</code> gates this page behind a private token that the browser holds in memory only.</p>
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
var countedToken='';  // which result is already folded into the tile counts, so the fold is idempotent
var reqSeq=0;         // request stamp: only the newest answer is allowed to paint
var sparkCache={};    // inbox -> built spark bars, so a redraw does not rebuild them
var lastVerdict='';   // so an unchanged answer is not read out again every 30s
var lastAlertHtml=''; // so the alerts are only announced when they really change
var countdown=REFRESH_SECS;
var hiddenSince=0;
var backTimer=null;
var BUTTONS=['btn-poll','btn-base','btn-test','btn-refresh','btn-test-fix','btn-poll-fix'];
var DASH='—';
/* Everything here is a network payload, so a missing, null or wrongly-typed field
   is a fact about the answer and never a reason for this page to invent one. */
function arr(v){return Array.isArray(v)?v:[];}
function num(v){var n=Number(v);return(typeof v==='boolean'||v==null||v===''||!isFinite(n))?null:n;}
function numText(v){var n=num(v);return n==null?DASH:String(n);}
function str(v){return(v==null)?'':(typeof v==='string'?v:(typeof v==='number'&&isFinite(v)?String(v):''));}
function h(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function el(id){return document.getElementById(id);}
/* Only write when the words really change: a live region must not repeat itself. */
function setText(id,v){var n=el(id);if(!n)return;v=String(v==null?'':v);if(n.textContent!==v)n.textContent=v;}
function rel(iso){if(typeof iso!=='string'||!iso)return DASH;var t=new Date(iso).getTime();if(!isFinite(t))return DASH;var d=Date.now()-t;if(d<45e3)return'just now';if(d<3600e3)return Math.round(d/60e3)+' min ago';if(d<86400e3)return Math.round(d/3600e3)+' h ago';return new Date(iso).toLocaleString();}
function ageText(ms){var n=num(ms);if(n==null||n<0)return DASH;var s=Math.round(n/1000);if(s<5)return'just now';if(s<90)return s+'s old';if(s<5400)return Math.round(s/60)+' min old';if(s<172800)return Math.round(s/3600)+' h old';return Math.round(s/86400)+' days old';}
function humanMs(ms){var n=num(ms);if(n==null||n<=0)return DASH;var s=Math.round(n/1000);if(s<60)return s+'s';return(n/60000).toFixed(n<600000?1:0)+'m';}
function secs(ms){var n=num(ms);return n==null?DASH:(n/1000).toFixed(1)+'s';}
function reduced(){try{return window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;}catch(e){return false;}}
/* A poll can legitimately take the whole IMAP budget, so the wait is bounded per
   endpoint rather than shared. The verb is explicit at every call site. */
var TIME_BUDGET={'/api/status':15000,'/api/poll-now':300000,'/api/baseline':300000,'/api/test-forward':90000};
function api(path,opts){
 opts=opts||{};
 var verb=String(opts.method||'').toUpperCase()||'GET';
 var payload=(verb==='POST')?(opts.body||{}):null;
 var ms=num(opts.timeoutMs)||TIME_BUDGET[path]||20000;
 var hd={};if(payload)hd['Content-Type']='application/json';if(token)hd['Authorization']='Bearer '+token;
 var ctrl=null;
 if(typeof AbortController!=='undefined'){try{ctrl=new AbortController();}catch(e){ctrl=null;}}
 var timer=null;
 var p=new Promise(function(resolve,reject){
  if(ms>0)timer=setTimeout(function(){try{if(ctrl)ctrl.abort();}catch(e){}
   reject(new Error('Sinka did not answer within '+((ms<1000)?'a second':(Math.round(ms/1000)+' seconds'))+'.'));},ms);
  fetch(path,{method:verb,headers:hd,body:payload?JSON.stringify(payload):undefined,signal:ctrl?ctrl.signal:undefined})
  .then(function(r){
   if(!r||typeof r.json!=='function')return{_http:(r&&r.status)||0,success:false,error:'The server sent back something unreadable.'};
   return r.json().then(function(j){return j;},function(){return null;})
    .then(function(j){
     if(j&&typeof j==='object'){try{j._http=r.status;}catch(e){}return j;}
     /* A login page, a proxy error page or a bare number is not a status
        object, so it is handed on as an envelope the caller can distrust. */
     return{_http:r.status,success:false,error:'The server sent back something unreadable (status '+r.status+').'};});})
  .then(resolve,reject);});
 /* Teardown in .finally, so a rejection can never skip it and strand the buttons. */
 return p.finally(function(){if(timer)clearTimeout(timer);});
}
function setFrozen(on){var b=document.body;if(b&&b.classList)b.classList.toggle('frozen',!!on);
 var f=el('frozen-note');if(f)f.hidden=!on;}
/* The tile lookup compares data-user in JS: a "]", a backslash or a quote in an
   address must never end up inside a CSS selector. */
function findTile(user){
 var host=el('dests'),list=[],i,n;
 if(host&&typeof host.querySelectorAll==='function')list=host.querySelectorAll('.tile');
 else if(typeof document.querySelectorAll==='function')list=document.querySelectorAll('#dests .tile');
 for(i=0;i<list.length;i++){n=list[i];if(n&&n.getAttribute&&n.getAttribute('data-user')===user)return n;}
 return null;}

/* ---- results in plain words; the raw reply stays available but folded away ---- */
function uniqReasons(fails){var seen={},out=[];for(var i=0;i<fails.length;i++){var r=str((fails[i]&&fails[i].error))||'no reason given';if(seen[r])continue;seen[r]=1;out.push(r);}return out;}
/* A result counts as a copy only when it was really filed: a bounce or an
   auto-reply comes back ok with a skipped reason and is filed away, not copied. */
function reallyFiled(x){return !!(x&&x.ok&&!x.skipped);}
function filedCount(res){var n=0;for(var i=0;i<res.length;i++)if(reallyFiled(res[i]))n++;return n;}
function outcome(o,ctx){
 if(!o||typeof o!=='object')return'The server did not send back an answer at all.';
 var msg=str(o.message);
 if(o.busy)return(msg||'A check was already running')+', so nothing was started a second time.';
 if(o.error){var lead=ctx==='test'?'The test copy was not filed. ':(ctx==='base'?'The backlog was not skipped. ':(ctx==='poll'?'The check did not finish. ':'That did not work. '));return lead+str(o.error)+(msg&&msg!==str(o.error)?' ('+msg+')':'');}
 if(o._http&&o._http>=400)return msg?(msg+'.'):('The server answered with status '+o._http+' instead of doing the job.');
 if(ctx==='test'&&o.dryRun)return'Practice mode, so nothing was really sent. Sinka worked out that the test copy would go to '+(str(o.to)||'the first inbox')+'.';
 if(Array.isArray(o.results)){
  var ok=0,filed=0,fails=[];o.results.forEach(function(x){if(reallyFiled(x)){ok++;filed++;}else if(x&&x.skipped)filed++;else fails.push(x);});
  var n=o.results.length,head='Filed one test copy into '+n+' inbox'+(n===1?'':'es')+': '+ok+' accepted';
  var away=(n-filed)?(', '+(n-filed)+' filed away, not a copy'):'';
  if(!fails.length&&!away)return head+', none refused.';
  if(!fails.length)return head+away+'.';
  return head+away+', '+fails.length+' failed: '+uniqReasons(fails).join('; ')+'.';}
 var base=num(o.baselined);
 if(base!=null)return'Marked '+base+' message'+(base===1?'':'s')+' as read and copied none of them. Sinka carries on with whatever arrives next.';
 var f=num(o.fetched);
 if(f!=null){
  if(!f)return'Looked in the source inbox just now. There was no new mail to copy.';
  var parts=['Found '+f+' new message'+(f===1?'':'s')];
  var rep=num(o.replicated);if(rep!=null)parts.push('filed '+rep+' cop'+(rep===1?'y':'ies'));
  var ret=num(o.retried);if(ret)parts.push('retried '+(ret===1?'1 copy':ret+' copies'));
  var sk=num(o.skipped);if(sk)parts.push('skipped '+sk);
  var pend=num(o.pending);if(pend)parts.push(pend+' still queued for the next check');
  return parts.join(', ')+'.';}
 var rep2=num(o.replicated);
 if(rep2!=null)return'Filed '+rep2+' cop'+(rep2===1?'y':'ies')+'.';
 return msg?msg:'The server accepted that and said nothing more.';}
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
 return p.then(function(o){showMsg(o,ctx);return thenRefresh?refresh():null;},
              function(e){showMsg({success:false,error:str(e&&e.message)||'the request did not finish'},ctx);})
  .then(function(){return null;},
        function(e){showMsg({success:false,error:'This page could not read the reply: '+(str(e&&e.message)||'unknown error')},ctx);})
  /* Teardown in .finally, so a rejection anywhere above can never leave every
     button on the page disabled. */
  .finally(function(){setBusy(false,btn);focusResult();});}

/* ---- "Start here" guide: shown until it is dismissed, then reopenable from the footer ---- */
function guideHidden(){try{return localStorage.getItem(GUIDE_KEY)==='1';}catch(e){return false;}}
function setGuide(show){var g=el('guide'),b=el('guide-close');if(g)g.hidden=!show;if(b)b.hidden=!show;try{if(show)localStorage.removeItem(GUIDE_KEY);else localStorage.setItem(GUIDE_KEY,'1');}catch(e){/* private mode: just keep it for this page view */}}
function openGuide(){setGuide(true);var g=el('guide');if(g&&g.scrollIntoView){try{g.scrollIntoView({block:'center',behavior:reduced()?'auto':'smooth'});}catch(e){g.scrollIntoView();}}}

/* ---- per-inbox copy counters driving the tile counts and sparklines ---- */
var stats={};
function statHits(user){var s=stats[user]||(stats[user]={total:0,hits:[]});var cut=Date.now()-60000;s.hits=s.hits.filter(function(t){return t>cut;});return s;}
function justNow(user){return !!(flashAt[user]&&(Date.now()-flashAt[user])<90000);}
/* The bars are decorative and they only change when the bucketed hit counts do,
   so an unchanged redraw reuses the markup it already built. */
function sparkHtml(user){
 var s=statHits(user),now=Date.now(),b=[],i,j,key='';
 for(i=0;i<12;i++){var t0=now-(12-i)*5000,t1=t0+5000,n=0;for(j=0;j<s.hits.length;j++){if(s.hits[j]>=t0&&s.hits[j]<t1)n++;}b.push(n);key+=n;}
 var cached=sparkCache[user];
 if(cached&&cached.key===key)return cached.html;
 var out='';
 for(i=0;i<12;i++){out+='<i aria-hidden="true"'+(b[i]?' class="hot"':'')+' style="height:'+Math.min(16,2+b[i]*4)+'px"></i>';}
 sparkCache[user]={key:key,html:out};
 return out;}
function tileHtml(a,cls,count,unit,note,jn){
 var j=!!jn;return '<div class="tile '+cls+(j?' jn':'')+'" data-user="'+h(a)+'">'
  +'<div class="t-name">'+h(a)+'</div>'
  +'<div class="t-foot"><span class="t-count">'+h(count)+'</span><span class="t-unit">'+h(unit)+'</span></div>'
  +((note||j)?'<div class="t-note'+(j?' jn':'')+'">'+(j?'copied just now':h(note))+'</div>':'')
  +'<div class="spark">'+sparkHtml(a)+'</div></div>';}
function renderDests(d){
 // Group labels here are the source of truth; the server's first paint mirrors them.
 var list=arr(d.destinations),on=arr(d.sinkUsers),off=arr(d.disabledSinks),auto=arr(d.autoDisabledSinks);
 var pending=arr(d.pendingSinks).filter(function(p){return p&&p.to;});
 var onS={},offS={},autoS={};on.forEach(function(a){onS[a]=1;});off.forEach(function(a){offS[a]=1;});auto.forEach(function(a){autoS[a]=1;});
 /* Every group is filtered first, and the heading counts the very list it draws,
    so the number can never disagree with the tiles under it. */
 function grp(title,items,cls){
  var rows=arr(items);
  if(!rows.length)return '';
  return '<div class="grp"><span class="grp-k">'+h(title)+'</span><span class="grp-n">'+rows.length+'</span></div><div class="tiles">'
   +rows.map(function(a){return tileHtml(a,cls,statHits(a).total,'copies','',justNow(a));}).join('')+'</div>';}
 function retryGrp(){
  if(!pending.length)return '';
  var tiles=pending.map(function(p){var n=num(p.attempts)||0;return tileHtml(p.to,'retry',n,n===1?'try':'tries','Waiting for the next check',false);}).join('');
  return '<div class="grp retry"><span class="grp-k">Trying again</span><span class="grp-n">'+pending.length+'</span></div><div class="tiles">'+tiles+'</div>'
   +'<p class="pipe-foot">'+pending.length+' cop'+(pending.length===1?'y':'ies')+' could not be filed yet, so Sinka keeps them queued and retries on the next check.</p>';}
 var liveRows=list.filter(function(a){return !!onS[a]&&!autoS[a];});
 var autoRows=list.filter(function(a){return !!autoS[a];});
 var offRows=list.filter(function(a){return !!offS[a];});
 var missRows=list.filter(function(a){return !onS[a]&&!offS[a];});
 var node=el('dests');if(!node)return;
 node.innerHTML=grp('Copying right now',liveRows,'on')
  +grp('Sign-in failed, waiting for you',autoRows,'auto')
  +grp('Paused by you',offRows,'off')
  +grp('No sign-in details yet',missRows,'miss')
  +retryGrp()
  +'<p class="pipe-foot">Nothing is copied to a tile until a copy really lands, so every count starts at zero.</p>';
 setText('d-count',malformedFields(d).length?'the answer was not a list this page can read':(list.length?(liveRows.length+' of '+list.length+' inboxes copying right now'):'No team inboxes listed yet'));
}
/* Which "what just happened" rows the operator had opened, so a 30s redraw does
   not snap them shut under the pointer. */
function openRowKeys(){
 var keys={},n=el('details'),i,d;
 if(!n||typeof n.querySelectorAll!=='function')return keys;
 var list=n.querySelectorAll('details[data-k]');
 for(i=0;i<list.length;i++){d=list[i];if(d&&d.open)keys[d.getAttribute('data-k')]=1;}
 return keys;}
function restoreOpenRows(keys){
 var n=el('details'),i,d,k;
 if(!keys||!n||typeof n.querySelectorAll!=='function')return;
 var list=n.querySelectorAll('details[data-k]');
 for(i=0;i<list.length;i++){d=list[i];k=d&&d.getAttribute?d.getAttribute('data-k'):null;if(k&&keys[k])d.open=true;}}
function resultVerdict(x){
 if(!x||typeof x!=='object')return'not filed: unknown reason';
 if(x.skipped)return'filed away, not a copy ('+str(x.skipped)+')';
 if(x.ok)return'filed'+(x.via?' ('+str(x.via)+')':'');
 return'not filed: '+(str(x.error)||'unknown reason');}
function renderDetails(r){
 var node=el('details');if(!node)return;
 var keys=openRowKeys();
 var det=arr(r.details);
 if(!det.length){node.innerHTML='<p class="empty">Nothing was copied in the last check. New mail shows up here the moment it arrives.</p>';return;}
 var rows=det.map(function(m,i){
  if(!m||typeof m!=='object')m={};
  var res=Array.isArray(m.results)?m.results:[];
  var ok=filedCount(res);
  var per=res.map(function(x){return '<li>'+h(str(x&&x.to)||'an unnamed inbox')+' &mdash; '+h(resultVerdict(x))+'</li>';}).join('');
  var ref=str(m.messageId)||('message '+(i+1)),k=ref+'|'+res.length;
  return '<tr><td class="id"><code>'+h(ref.slice(0,28))+'</code></td>'
   +'<td><span class="subj">'+h(str(m.subject)||'(no subject)')+'</span><span class="fr">from '+h(str(m.from)||'an unknown sender')+'</span></td>'
   +'<td><details data-k="'+h(k)+'"><summary>'+ok+' of '+res.length+' filed</summary><ul>'+per+'</ul></details></td></tr>';
 }).join('');
 node.innerHTML='<table><caption class="vh">Messages from the most recent check</caption><thead><tr><th scope="col">Reference</th><th scope="col">Message</th><th scope="col">Copies</th></tr></thead><tbody>'+rows+'</tbody></table>';
 restoreOpenRows(keys);
}
/* Coverage, not configuration: a count of configured sinks says nothing about
   whether every listed inbox has sign-in details, so the missing ones are
   worked out per address. The hero, the alerts, the fix card and the checklist
   all read this one answer, so they cannot disagree with each other. */
function coverage(d){
 var dests=arr(d.destinations);
 var have=(typeof d.sinksConfigured==='number'&&isFinite(d.sinksConfigured))?d.sinksConfigured:arr(d.sinkUsers).length;
 var onS={},autoS={},i,a;
 arr(d.sinkUsers).forEach(function(x){onS[x]=1;});
 arr(d.autoDisabledSinks).forEach(function(x){autoS[x]=1;});
 var covered=0,missing=[];
 for(i=0;i<dests.length;i++){a=dests[i];if(onS[a]&&!autoS[a])covered++;else missing.push(a);}
 var ready=(Array.isArray(d.sinkUsers)&&dests.length)?covered:Math.min(have,dests.length);
 var missN=Math.max(0,dests.length-ready);
 return{total:dests.length,have:have,ready:Math.min(ready,dests.length),missing:missing,missingCount:missN,
  refused:arr(d.autoDisabledSinks).length,paused:arr(d.disabledSinks).length};}
function needLine(n){return n===1?'1 inbox needs your help':n+' inboxes need your help';}
/* A field that is present but is not the list the server documents. Saying "no
   team inboxes" about a field this page cannot read would be inventing a fact, so
   these are named instead. Never an outage: the answer did arrive. */
function malformedFields(d){
 var bad=[],r=(d.lastResult&&typeof d.lastResult==='object')?d.lastResult:null;
 if(d.destinations!=null&&!Array.isArray(d.destinations))bad.push('destinations');
 if(d.sinkUsers!=null&&!Array.isArray(d.sinkUsers))bad.push('sinkUsers');
 if(d.disabledSinks!=null&&!Array.isArray(d.disabledSinks))bad.push('disabledSinks');
 if(d.autoDisabledSinks!=null&&!Array.isArray(d.autoDisabledSinks))bad.push('autoDisabledSinks');
 if(d.pendingSinks!=null&&!Array.isArray(d.pendingSinks))bad.push('pendingSinks');
 if(r&&r.details!=null&&!Array.isArray(r.details))bad.push('lastResult.details');
 return bad;}
function malformedLine(bad){return 'The server sent an answer this page cannot read in full ('+bad.join(', ')+' is not a list), so this page will not guess what it means.';}
function renderHero(d,r,cov){
 var hero=el('hero'),face=el('hero-face'),t=el('hero-t'),s=el('hero-s');
 if(!hero||!face||!t||!s)return;
 var cls='ok',symbol='\u25cf',line='Everything is working',sub='New mail is being copied into your team inboxes.';
 var bad=malformedFields(d);
 if(!stateKnown(d)){cls='warn';symbol='\u25cc';line='The server has not told this page anything yet';sub='Sinka answered, but the reply carried no numbers. This page will not invent any; it keeps asking.';}
 else if(bad.length){cls='warn';symbol='\u25d0';line='The server sent an answer this page cannot read in full';sub=malformedLine(bad)+' The numbers below are only the ones it could read.';}
 else if(d.setupNeeded){cls='err';symbol='\u2715';line='One more step needed';sub='Sinka cannot copy anything until its own sign-in details are set. The details are below.';}
 else if(r.error){cls='err';symbol='\u2715';line='The last check did not finish';sub='Sinka is waiting and trying again on its own, a little longer each time. The details are below.';}
 else if(cov.refused){cls='warn';symbol='\u25d0';line=needLine(cov.refused);sub='A sign-in was refused. Fix it, then choose Send a test copy.';}
 else if(cov.missingCount){cls='warn';symbol='\u25d0';line=needLine(cov.missingCount);sub=cov.missingCount+' of the '+cov.total+' listed inboxes'+(cov.missingCount===1?' has':'es have')+' no sign-in details yet, so nothing is copied there. Add the app password, then send a test copy.';}
 else if(!cov.total||!d.sinksConfigured){cls='warn';symbol='\u25d0';line='No team inboxes yet';sub='Add at least one team inbox in the server settings, then send a test copy to check it.';}
 else if(!d.lastPollAt){cls='warn';symbol='\u25cc';line='Starting up';sub='The first check runs in a few seconds.';}
 else if(humanMs(d.pollIntervalMs)===DASH){cls='warn';symbol='\u25cc';line='Waiting for the first check';sub='This page cannot see how often checks run yet.';}
 var none=!cov.total;
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
   With no answer from Sinka, or with an answer that carried no facts at all, it says so
   instead of guessing or staying blank. */
var STEP_TITLES=['Sinka is signed in to the source inbox','Team inboxes can sign in','A copy has really landed'];
var NOT_TOLD='The server has not told this page anything yet, so this page cannot say.';
/* "Answered but silent" is not "fine": without these fields there is nothing to assert. */
function stateKnown(d){
 if(!d||typeof d!=='object')return false;
 return ('setupNeeded' in d)||!!d.startedAt||!!d.lastPollAt||d.sinksConfigured!=null||arr(d.destinations).length>0||!!d.seenCount;}
function renderSteps(d,r,unknown){
 var box=el('steps');if(!box)return;
 if(!r||typeof r!=='object')r={};
 var why=unknown||(!stateKnown(d)?NOT_TOLD:'');
 if(why){box.innerHTML=[0,1,2].map(function(i){return ck(i+1,false,false,STEP_TITLES[i],why);}).join('');return;}
 var cov=coverage(d);
 var dests=cov.total;
 var refused=cov.refused;
 var filed=(num(r.replicated)||0)+(num(r.retried)||0),ev=0;
 arr(r.details).forEach(function(m){arr(m&&m.results).forEach(function(x){if(reallyFiled(x))ev++;});});
 var rows=[];
 rows.push(ck(1,!d.setupNeeded,!!d.setupNeeded,
  d.setupNeeded?'Sinka is not signed in yet':'Sinka is signed in to the source inbox',
  d.setupNeeded?"Fill in Sinka's own sign-in details in the server settings. Until then it cannot read the source inbox.":'Sinka can read the source inbox, so it is ready to copy.'));
 var missN=cov.missingCount;
 rows.push(ck(2,dests>0&&missN<=0&&!refused,dests===0||missN>0||refused>0,
  dests?(cov.ready+' of '+dests+' inboxes can sign in'):'No team inboxes listed yet',
  !dests?'Add at least one team inbox in the server settings, then send a test copy.'
  :(refused?refused+' sign-in'+(refused===1?' was':'s were')+' refused, so copying is paused there. Fix the password, then choose Send a test copy.'
  :(missN>0?missN+' inbox'+(missN===1?' has':'es have')+' no sign-in details yet.':'Every listed inbox is ready to receive copies.'))));
 var seen=num(d.seenCount)||0,landed=(seen>0)||filed>0||ev>0;
 rows.push(ck(3,landed,false,
  landed?'A copy has really landed':'No copy delivered yet',
  landed?'At least one message was filed into a team inbox, so the copying works end to end.'
  :'Nothing has come in to the source inbox yet, so there is nothing to copy. This is normal until mail arrives.'));
 box.innerHTML=rows.join('');
}
function renderFix(d,cov){
 var w=el('fix-what');if(!w)return;var line;
 var bad=malformedFields(d);
 if(bad.length)line=malformedLine(bad)+' Fix the server, then send a test copy.';
 else if(!stateKnown(d))line='The server has not told this page anything yet, so there is nothing to suggest until it answers with real numbers.';
 else if(d.setupNeeded)line="Sinka's own sign-in details are missing. Fill them in on the server, then come back and send a test copy.";
 else if(cov.refused)line='A sign-in was refused for '+arr(d.autoDisabledSinks).join(', ')+'. Fix the password on the server, then send a test copy to switch copying back on.';
 else if(!cov.total||!d.sinksConfigured)line='No team inbox is ready. Add one in the server settings, then send a test copy to check it.';
 else if(cov.missingCount)line=cov.missingCount+' listed inbox'+(cov.missingCount===1?' has':'es have')+' no sign-in details yet, so nothing is copied there. Add the app password on the server, then send a test copy.';
 else if(cov.paused)line='Nothing to fix. '+cov.paused+' inbox'+(cov.paused===1?' is':'es are')+' paused on purpose.';
 else if(d.consecutiveErrors)line='Nothing to fix. Sinka is waiting longer between tries after a failed check.';
 else line='Nothing needs fixing right now. A test copy is the quickest way to prove copying works.';
 setText('fix-what',line);}
/* A stable token for one distinct result. /api/status keeps returning the same
   lastResult until the next poll, so a fold keyed on anything less than this
   would count one delivered message again on every 30s redraw. */
function resultToken(d,r){
 var det=arr(r.details),ids=[],i;
 for(i=0;i<det.length;i++)ids.push(str(det[i]&&det[i].messageId)||String(i));
 return str(d.lastPollAt)+'|'+str(r.ms)+'|'+det.length+'|'+ids.join(',');}
/* One delivered copy, one increment, one lasting mark. Returns the inboxes that
   this call advanced, so only they flash. A message already counted inside the
   dedupe window is not counted again, whatever result carries it. */
var DEDUPE_MS=600000,countedMsgs={};
function foldCopies(r){
 var det=arr(r.details),now=Date.now(),users=[],i,j,k;
 for(k in countedMsgs)if(countedMsgs[k]<now-DEDUPE_MS)delete countedMsgs[k];
 for(i=0;i<det.length;i++){
  var msg=det[i],res=arr(msg&&msg.results);
  for(j=0;j<res.length;j++){
   var x=res[j];
   if(!reallyFiled(x)||!x.to)continue;
   k=str(msg&&msg.messageId)+'|'+str(x.to);
   if(countedMsgs[k])continue;
   countedMsgs[k]=now;
   var st=statHits(x.to);st.total++;st.hits.push(now);flashAt[x.to]=now;
   if(users.indexOf(x.to)<0)users.push(x.to);
  }}
 return users;}
function render(d){
 d=(d&&typeof d==='object')?d:{};
 var r=(d.lastResult&&typeof d.lastResult==='object')?d.lastResult:{};
 var known=stateKnown(d),cov=coverage(d),bad=malformedFields(d);
 setText('upd',d.lastPollAt?('Updated '+rel(d.lastPollAt)+'.'):'');
 setText('c-last',d.lastPollAt?rel(d.lastPollAt):DASH);
 setText('c-last-s',str(r.reason)+(r.ms!=null?' \u00b7 took '+secs(r.ms):'')+(r.error?' \u00b7 did not finish':''));
 setText('c-fetched',r.fetched!=null?numText(r.fetched):DASH);
 setText('c-repl',r.replicated!=null?numText(r.replicated):DASH);
 setText('c-skip',r.skipped!=null?numText(r.skipped):DASH);
 setText('c-seen',d.seenCount!=null?numText(d.seenCount):DASH);
 setText('c-int',humanMs(d.pollIntervalMs));
 setText('c-up',d.startedAt?('this page has been open since '+new Date(d.startedAt).toLocaleTimeString()):'');
 setText('c-rail-last',d.lastPollAt?rel(d.lastPollAt):DASH);
 setText('c-rail-int',humanMs(d.pollIntervalMs));
 paintRail();
 setText('b-sinks','Team inboxes set up: '+(num(d.sinksConfigured)!=null?num(d.sinksConfigured):'?'));
 setText('fix-to',testTargetLine());
 var replBox=document.querySelector('[data-metric="repl"]');
 if(replBox)replBox.className='metric'+((num(r.replicated)||0)>0?' good':((num(r.replicated)===0)?' zero':''));
 // Note the real copies first, so a tile can carry a lasting "copied just now" mark
 // (the 800ms flash is motion, and motion is not allowed to be the only signal).
 // Idempotent: a result already folded in is never folded in twice.
 var tok=resultToken(d,r),fresh=null;
 if(tok!==countedToken){countedToken=tok;fresh=foldCopies(r);}
 renderDests(d);
 if(fresh&&fresh.length&&!reduced()){var tiles=[];
  for(var fi=0;fi<fresh.length;fi++){var tn=findTile(fresh[fi]);if(tn){tn.classList.add('flash');tiles.push(tn);}}
  if(tiles.length)setTimeout(function(){for(var ti=0;ti<tiles.length;ti++)tiles[ti].classList.remove('flash');},800);}
 if((num(r.fetched)||0)>0){var cd2=el('conduit');if(cd2){cd2.classList.add('live');setTimeout(function(){cd2.classList.remove('live');},2500);}}
 var dot=el('srcdot'),ps=el('pipe-state');
 if(dot){dot.classList.remove('dead');dot.classList.toggle('idle',!!(!known||bad.length||d.setupNeeded||r.error||(num(d.consecutiveErrors)||0)>0));
  if(ps)ps.textContent=!known?'the server said nothing':(bad.length?'answer not fully readable':(d.setupNeeded?'not set up yet':(r.error?'last check failed':'checking on its own')));}
 renderHero(d,r,cov);
 var al=[];
 if(bad.length)al.push('<div class="alert warn"><b>This page cannot read the whole answer.</b> '+h(malformedLine(bad))+'</div>');
 if(!known)al.push('<div class="alert warn"><b>The server has not told this page anything yet.</b> It answered, but the reply carried no inbox list, no check times and no counts, so nothing on this page can be trusted yet. It keeps asking every '+REFRESH_SECS+' seconds.</div>');
 if(d.setupNeeded)al.push('<div class="alert err"><b>One more step needed.</b> Sinka cannot copy any mail until its own sign-in details are set. Details: <code>'+h(d.setupNeeded)+'</code></div>');
 if(!bad.length&&(!cov.total||!d.sinksConfigured))al.push('<div class="alert warn"><b>Nothing is being copied yet.</b> No team inbox is ready. Add one in the server settings, then choose Send a test copy to check it.</div>');
 if(cov.paused)al.push('<div class="alert warn"><b>Paused on purpose.</b> '+arr(d.disabledSinks).map(h).join(', ')+' will not receive copies until you take the leading dash off the address in the server settings.</div>');
 if(cov.missingCount)al.push('<div class="alert warn"><b>'+h(needLine(cov.missingCount))+'.</b> '+cov.missing.map(h).join(', ')+' &mdash; no sign-in details yet, so nothing is copied there. Add the app password for each, then choose Send a test copy.</div>');
 if(cov.refused)al.push('<div class="alert err"><b>Sign-in was refused.</b> '+arr(d.autoDisabledSinks).map(h).join(', ')+' &mdash; the password was rejected or revoked. Fix it, then choose Send a test copy to switch copying back on.</div>');
 if(r.error)al.push('<div class="alert err"><b>The last check did not finish</b> ('+h(str(r.reason)||'automatic')+'): <code>'+h(r.error)+'</code></div>');
 if(num(d.consecutiveErrors))al.push('<div class="alert note"><b>Being patient.</b> '+num(d.consecutiveErrors)+' check'+(num(d.consecutiveErrors)===1?'':'s')+' in a row did not finish, so Sinka is waiting longer between tries, up to an hour.</div>');
 if(!al.length&&!bad.length&&!cov.total)al.push('<div class="alert warn"><b>No team inboxes listed.</b> There is nowhere to put copies yet. Add at least one inbox in the server settings.</div>');
 renderAlerts(al);
 renderFix(d,cov);
 renderSteps(d,r,bad.length?('The server sent '+bad.join(', ')+' in a form this page cannot read, so it cannot say.'):'');
 renderDetails(r);
}
function paintRail(){setText('c-rail-age',lastGoodAt?ageText(Date.now()-lastGoodAt):DASH);}
function answeredAgo(){return lastGoodAt?ageText(Date.now()-lastGoodAt):'never';}
function noteBack(text){var n=el('hero-back');if(!n)return;n.textContent=text;n.hidden=false;
 if(backTimer)clearTimeout(backTimer);backTimer=setTimeout(function(){n.hidden=true;},8000);}
/* The server is gone, or it answered with something this page must not trust.
   Say so, stop the numbers pretending to be live, keep retrying. */
function netDown(e,kind){
 if(!netDownAt)netDownAt=Date.now();
 var why=str(e&&e.message)||str(e)||'no answer';
 var auth=(kind==='auth');
 var hero=el('hero');
 if(hero)hero.className='card hero down';
 var t=el('hero-t'),s=el('hero-s'),face=el('hero-face');
 var line=auth?(token?'The private token was not accepted \u2014 no numbers to show':'Paste your private token to see live numbers')
  :"Can't reach Sinka \u2014 the numbers below may be out of date";
 var sub=auth?(token?'Sinka answered, but it would not show its numbers to this tab. Paste the private token again in step 1 below, then refresh.'
  :'Sinka answered, but it will not show its numbers without the private token for this dashboard. Paste it in step 1 below: this page keeps it in this tab only, never on disk.')
  :'This page cannot talk to Sinka, so nothing below is moving: these are the numbers from the last time it answered. It keeps trying every '+REFRESH_SECS+' seconds.';
 if(t&&s&&t.textContent!==line){if(face)face.textContent='\u2715';t.textContent=line;s.textContent=sub;}
 lastVerdict='down';
 setFrozen(true);
 var dot=el('srcdot');if(dot){dot.classList.remove('idle');dot.classList.add('dead');}
 setText('pipe-state',auth?'waiting for the private token':(lastGoodAt?'out of reach, numbers frozen':'cannot reach Sinka'));
 setText('cd-note','Redraws these numbers only. Nothing new can arrive until Sinka answers again.');
 setText('upd','These numbers stopped moving. Last answer from Sinka: '+answeredAgo()+'.');
 setText('d-count','out of reach \u2014 not moving');
 setText('fix-what',auth?'Nothing on this page can be checked until the private token is pasted in step 1 below.':'Sinka cannot be reached, so there is nothing this page can do until it answers again.');
 renderSteps(null,null,auth?'This page cannot show live numbers until the private token is pasted in step 1 below.':'Sinka is out of reach, so this page cannot say yet. It keeps trying every '+REFRESH_SECS+' seconds.');
 renderAlerts(['<div class="alert err"><b>'+(auth?'This page is not authorized yet.':'This page cannot reach Sinka.')+'</b> Everything below is the last thing that really arrived, and it is not changing until the server answers again. Details: <code>'+h(why)+'</code></div>']);
 paintRail();
}
/* Sinka answered, but this page threw while drawing it. That is a bug here, not
   an outage there: say so, and do not freeze or blame the server. */
function renderBug(e){
 var why=str(e&&e.message)||str(e)||'unknown error';
 var hero=el('hero');if(hero)hero.className='card hero warn';
 var face=el('hero-face'),t=el('hero-t'),s=el('hero-s'),line='This page could not draw the numbers';
 if(t&&t.textContent!==line){if(face)face.textContent='\u25d0';t.textContent=line;s.textContent='Sinka answered, so the service is fine. This page hit its own bug while drawing the reply and shows nothing new; the numbers below are the last ones it managed to draw.';}
 lastVerdict='bug';
 setText('cd-note','Redraws these numbers only. The last redraw failed inside this page, not in Sinka.');
 renderAlerts(['<div class="alert warn"><b>This page hit its own bug.</b> Sinka answered, so the service is fine, but the dashboard could not draw the reply. Nothing is frozen: the next redraw tries again. Details: <code>'+h(why)+'</code></div>']);
}
/* An answer this page must not treat as a status object: a refused or
   unauthorized envelope, or an unreadable body. */
function envelopeProblem(d){
 if(!d||typeof d!=='object'||Array.isArray(d))return 'The server sent back an answer this page cannot read.';
 if(d.success===false)return str(d.error)||str(d.message)||'The server refused to answer.';
 if(typeof d._http==='number'&&d._http>=400)return str(d.error)||str(d.message)||('The server answered with status '+d._http+'.');
 return '';}
function refresh(){
 var seq=++reqSeq;
 return api('/api/status',{method:'GET'}).then(function(d){
  if(seq!==reqSeq)return null;                 // a newer request owns the page now
  var bad=envelopeProblem(d);
  if(bad){netDown({message:bad},(d&&d._http===401)?'auth':null);return null;}
  var was=netDownAt;
  netDownAt=0;lastGood=d||{};lastGoodAt=Date.now();
  setFrozen(false);
  try{render(lastGood);}
  /* A renderer bug is reported as a bug: it must not claim the server is down. */
  catch(err){renderBug(err);return null;}
  countdown=REFRESH_SECS;setText('cd',countdown);
  if(was)noteBack('Reconnected \u2014 these numbers are live again.');
  return lastGood;})
  .catch(function(e){
   if(seq!==reqSeq)return null;                 // a stale failure never paints over fresh data
   netDown(e);return null;});}
var guideClose=el('guide-close');if(guideClose)guideClose.onclick=function(){setGuide(false);};
var guideOpen=el('guide-open');if(guideOpen)guideOpen.onclick=function(){openGuide();};
var heroGuide=el('hero-guide');if(heroGuide)heroGuide.onclick=function(e){e.preventDefault();openGuide();};
/* Where a test copy would actually go, so the narrow-screen fix card can say it. */
function testTarget(){
 var n=el('inp-to'),v=n?String(n.value==null?'':n.value).trim():'';
 if(v)return v;
 var d=lastGood&&typeof lastGood==='object'?lastGood:null;
 var list=arr(d&&d.destinations);
 return list.length?String(list[0]):'';}
function testTargetLine(){
 var to=testTarget();
 return to?('Test copy goes to '+to+'.'):'No test destination yet: fill one in above, or add a team inbox in the server settings.';}
var btnRefresh=el('btn-refresh');
if(btnRefresh)btnRefresh.onclick=function(){setBusy(true,btnRefresh,'Refreshing\u2026');
 var p;try{p=refresh();}catch(e){p=Promise.reject(e);}
 /* Teardown in .finally: a rejected refresh must never leave the buttons stuck. */
 p.finally(function(){setBusy(false,btnRefresh);});};
var btnPoll=el('btn-poll');
if(btnPoll)btnPoll.onclick=function(){runAction(btnPoll,'Checking\u2026','poll',function(){return api('/api/poll-now',{method:'POST',body:{}});},true);};
var btnPollFix=el('btn-poll-fix');
if(btnPollFix)btnPollFix.onclick=function(){runAction(btnPollFix,'Checking\u2026','poll',function(){return api('/api/poll-now',{method:'POST',body:{}});},true);};
var btnTest=el('btn-test');
if(btnTest)btnTest.onclick=function(){var to=el('inp-to');runAction(btnTest,'Sending\u2026','test',function(){return api('/api/test-forward',{method:'POST',body:{to:to?to.value:''}});},false);};
var btnTestFix=el('btn-test-fix');
if(btnTestFix)btnTestFix.onclick=function(){var to=el('inp-to');runAction(btnTestFix,'Sending\u2026','test',function(){return api('/api/test-forward',{method:'POST',body:{to:to?to.value:''}});},false);};
var btnBase=el('btn-base');
if(btnBase)btnBase.onclick=function(){if(!confirm('Skip the backlog? This marks everything currently unread in the source inbox as read and copies none of it. It cannot be undone.'))return;
 runAction(btnBase,'Skipping\u2026','base',function(){return api('/api/baseline',{method:'POST',body:{}});},true);};
var inpToken=el('inp-token');if(inpToken)inpToken.oninput=function(e){token=e.target.value.trim();};
var inpTo=el('inp-to');if(inpTo)inpTo.oninput=function(){setText('fix-to',testTargetLine());};
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
 setText('cd-note','Redraws these numbers only. Sinka checks mail on its own timer.');
 countdown=REFRESH_SECS;setText('cd',countdown);
 refresh().then(function(){if(away>45000&&!netDownAt)noteBack('Welcome back \u2014 updated just now.');},function(){});});
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
    console.log(`Sinka listening on :${cfg.port} (hostname sinka.example.com -> localhost:${cfg.port})`);
  });
  // Initial poll shortly after boot, then on interval. Overlaps are skipped
  // by awaiting; a slow poll simply delays the next tick.
  setTimeout(() => poll('boot'), 5000);
  setInterval(() => poll('timer'), cfg.pollIntervalMs);
}
