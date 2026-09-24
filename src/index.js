import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { createStoreAuto } from './store_d1.js';
import { loadConfig, parseSinks, fetchNewMessages, countUnseen, markUidsSeen, replicateMessage, appendTestMessage, getAutoDisabled } from './mail.js';

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
      return state.lastResult;
    }
    const messages = await withTimeout(fetchNewMessages(cfg), IMAP_BUDGET_MS, 'fetchNewMessages');
    let replicated = 0;
    let skipped = 0;
    const details = [];
    const uidsToFlag = [];
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
      skipped,
      destinations: cfg.forwardList.length,
      details: details.slice(0, 20),
    };
    state.consecutiveErrors = 0;
    console.log(`[poll] fetched=${messages.length} replicated=${replicated} skipped=${skipped} (${state.lastResult.ms}ms)`);
    return state.lastResult;
    } catch (err) {
      state.consecutiveErrors++;
      // Back off on errors (throttle protection): 5min, 10min, 20min... capped at 60min.
      const backoffMs = Math.min(3600000, 300000 * Math.pow(2, state.consecutiveErrors - 1));
      nextAllowedAt = Date.now() + backoffMs;
      state.lastPollAt = new Date().toISOString();
      state.lastResult = { reason, error: err?.message || String(err) };
      console.error('[poll] failed:', err?.message || err, `(backing off ${Math.round(backoffMs / 60000)}min)`);
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
  const chip = (a, cls) => `<code class="${cls}">${escHtml(a)}</code>`;
  const on = cfg.forwardList.filter((a) => sinkUsers.has(a) && !autoUsers.has(a)).map((a) => chip(a, 'on')).join(' ');
  const auto = cfg.forwardList.filter((a) => autoUsers.has(a)).map((a) => chip(a, 'auto')).join(' ');
  const off = cfg.forwardList.filter((a) => disUsers.has(a)).map((a) => chip(a, 'off')).join(' ');
  const miss = cfg.forwardList.filter((a) => !sinkUsers.has(a) && !disUsers.has(a)).map((a) => chip(a, 'miss')).join(' ');
  const destHtml = `${on ? `<div class="grp">Active (${sinkUsers.size - autoUsers.size}) — receiving copies</div><div class="dests">${on}</div>` : ''}`
    + `${auto ? `<div class="grp">Auto-disabled — wrong or revoked password?</div><div class="dests">${auto}</div>` : ''}`
    + `${off ? `<div class="grp">Disabled — kept, prefixed with -</div><div class="dests">${off}</div>` : ''}`
    + `${miss ? `<div class="grp">No App Password yet — skipped</div><div class="dests">${miss}</div>` : ''}`;
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>sinka · replicator dashboard</title>
<style>
:root{color-scheme:dark;--bg:#0B0F19;--card:#141B2D;--ink:#e2e8f0;--mut:#94A3B8;--line:#1F293D;--ok:#34D399;--warn:#FBBF24;--err:#F87171;--acc:#38BDF8;--lav:#A78BFA}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f8fafc;--card:#fff;--ink:#0f172a;--mut:#64748b;--line:#e2e8f0;--ok:#15803d;--warn:#b45309;--err:#b91c1c;--acc:#0284c7;--lav:#7c3aed}}
*{box-sizing:border-box}body{font-family:Inter,system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--ink);margin:0;padding:0 1rem 3rem;font-size:.875rem}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.wrap{max-width:960px;margin:0 auto}header{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:baseline;margin:2rem 0 1rem}
header h1{font-size:1.25rem;margin:0;letter-spacing:-.01em}header h1 .dot{color:var(--acc)}.sub{color:var(--mut);font-size:.875rem}
.badges{display:flex;gap:.4rem;flex-wrap:wrap}.badge{font-size:.75rem;border:1px solid var(--line);border-radius:999px;padding:.15rem .6rem;background:var(--card)}
.badge.warn{color:var(--warn);border-color:var(--warn)}.badge.ok{color:var(--ok);border-color:var(--ok)}
.alert{border:1px solid;border-radius:8px;padding:.7rem 1rem;margin:.6rem 0;font-size:.875rem}
.alert.err{color:var(--err);border-color:var(--err)}.alert.warn{color:var(--warn);border-color:var(--warn)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.7rem;margin:1rem 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.8rem 1rem}
.card .k{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:var(--mut)}
.card .v{font-size:1.25rem;font-weight:700;margin-top:.2rem}.card .s{font-size:.78rem;color:var(--mut)}
section.card{margin:1rem 0}section h2{font-size:1.25rem;margin:.1rem 0 .6rem;font-weight:700}
table{width:100%;border-collapse:collapse;font-size:.82rem}th,td{text-align:left;padding:.35rem .4rem;border-top:1px solid var(--line);vertical-align:top}
th{border-top:0;color:var(--mut);font-weight:600}code{background:var(--bg);border:1px solid var(--line);padding:.05rem .3rem;border-radius:4px;font-size:.8em;word-break:break-all}
.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
button,input{font:inherit;color:var(--ink)}button{background:var(--acc);color:#04121f;border:0;border-radius:8px;padding:.5rem 1rem;cursor:pointer;transition:transform .15s ease,opacity .15s ease}
button:hover:not(:disabled){transform:translateX(2px);opacity:.92}button.ghost{background:transparent;color:var(--acc);border:1px solid var(--acc)}
button:disabled{opacity:.4;cursor:wait}input[type=text],input[type=password]{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.45rem .6rem;min-width:0;transition:opacity .15s ease}input:hover{opacity:1}
#result{white-space:pre-wrap;font-size:.82rem;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.7rem;margin-top:.6rem;max-height:220px;overflow:auto}
.mut{color:var(--mut);font-size:.8rem}
footer{margin-top:2rem}.dests{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:.4rem;margin-top:.2rem}.dests code{display:block;margin:0;padding:.4rem .6rem;transition:border-color .3s ease,opacity .15s ease}
.dests code:hover{opacity:1}.dests code.off{opacity:.4}
.dests code.on{color:var(--ok);border-color:var(--ok)}
.dests code.off{color:var(--mut)}
.dests code.miss{color:var(--warn);border-color:var(--warn)}
.dests code.auto{color:var(--err);border-color:var(--err)}
.dests code.pulse{border-color:var(--lav);box-shadow:0 0 0 1px var(--lav)}
.dests .grp{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin:.5rem 0 .2rem;grid-column:1/-1}
.pipe{display:grid;grid-template-columns:1fr 64px;gap:.7rem;align-items:stretch;margin:.5rem 0}
.src{border:1px solid var(--line);border-radius:10px;padding:.7rem .9rem;background:var(--card)}
.src .k{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:var(--mut)}
.src .v{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85rem;margin-top:.2rem;word-break:break-all}
.conduit{position:relative;overflow:hidden;border-radius:6px;background:linear-gradient(90deg,transparent 0%,var(--lav) 50%,transparent 100%);background-size:64px 2px;background-repeat:repeat-x;background-position:center;opacity:.4;animation:flow 2.4s linear infinite;min-height:100%}
@keyframes flow{from{background-position-x:0}to{background-position-x:64px}}
@media (prefers-reduced-motion:reduce){.conduit{animation:none}button:hover:not(:disabled){transform:none}}
details summary{cursor:pointer;font-size:.82rem}
</style>
</head><body><div class="wrap">
<header><h1>sinka</h1><span class="sub">IMAP replicator · <code>${escHtml(cfg.gmailUser)}</code> → <b>${cfg.forwardList.length}</b> inboxes</span></header>
<div class="badges"><span class="badge ok">imap append</span><span class="badge" id="b-sinks">sinks: ${cfg.sinks.length}</span>${cfg.dryRun ? '<span class="badge warn">DRY RUN</span>' : '<span class="badge ok">live</span>'}</div>
<div id="alerts"></div>
<section class="card"><h2>Status <span class="mut" id="upd"></span></h2>
<div class="grid">
<div class="card"><div class="k">Last poll</div><div class="v" id="c-last">—</div><div class="s" id="c-last-s"></div></div>
<div class="card"><div class="k">Fetched</div><div class="v" id="c-fetched">—</div><div class="s">last poll</div></div>
<div class="card"><div class="k">Replicated</div><div class="v" id="c-repl">—</div><div class="s">last poll</div></div>
<div class="card"><div class="k">Skipped</div><div class="v" id="c-skip">—</div><div class="s">last poll</div></div>
<div class="card"><div class="k">Seen IDs</div><div class="v" id="c-seen">—</div><div class="s">dedupe store</div></div>
<div class="card"><div class="k">Interval</div><div class="v" id="c-int">—</div><div class="s" id="c-up"></div></div>
</div>
<div class="row"><button class="ghost" id="btn-refresh">Refresh</button><span class="mut">auto-refresh in <b id="cd">30</b>s</span></div>
</section>
<section class="card"><h2>Actions</h2>
<div class="row"><button id="btn-poll">Poll now</button><button class="ghost" id="btn-base">Baseline unseen (no forward)</button></div>
<div class="row" style="margin-top:.6rem"><input type="text" id="inp-to" placeholder="test address" value="${escHtml(cfg.forwardList[0] || '')}"><button class="ghost" id="btn-test">Send test copy</button></div>
<div class="row" style="margin-top:.6rem"><input type="password" id="inp-token" placeholder="Admin token (only if ADMIN_TOKEN is set)"><span class="mut">sent as Bearer header</span></div>
<div id="result" hidden></div>
</section>
<section class="card"><h2>Last poll details</h2><div id="details" class="mut">No poll yet.</div></section>
<section class="card"><h2>Pipeline <span class="mut" id="d-count"></span></h2><div class="pipe"><div class="src"><div class="k">Source inbox</div><div class="v">${escHtml(cfg.gmailUser)}</div></div><div class="conduit" title="source → sinks"></div></div><div id="dests">${destHtml}</div><p class="mut">Green = receiving copies · gray = disabled (-) · amber = no App Password yet · red = auto-disabled, fix password then Send test copy to re-enable.</p></section>
<footer><p class="mut">Protected by Cloudflare Access (Email OTP, only ${escHtml(cfg.gmailUser)}). Do not expose this port directly. API: <code>GET /api/status</code> · <code>POST /api/poll-now</code> · <code>POST /api/baseline</code> · <code>POST /api/test-forward</code></p></footer>
</div>
<script>
var token='';
var prevRepl=0;
function h(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function rel(iso){if(!iso)return'—';var t=new Date(iso).getTime(),d=Date.now()-t;if(isNaN(t))return'—';if(d<45e3)return'just now';if(d<3600e3)return Math.round(d/60e3)+'m ago';if(d<86400e3)return Math.round(d/3600e3)+'h ago';return new Date(iso).toLocaleString();}
function humanMs(ms){if(ms==null)return'—';var s=Math.round(ms/1000);if(s<60)return s+'s';return (ms/60000).toFixed(ms<600000?1:0)+'m';}
function api(path,body){var hd={'Content-Type':'application/json'};if(token)hd['Authorization']='Bearer '+token;
return fetch(path,{method:body?'POST':'GET',headers:hd,body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().then(function(j){j._http=r.status;return j;});});}
function showMsg(o){var el=document.getElementById('result');el.hidden=false;el.textContent=JSON.stringify(o,null,2);}
function setBusy(b){['btn-poll','btn-base','btn-test','btn-refresh'].forEach(function(id){document.getElementById(id).disabled=b;});}
function renderDests(d){
var list=d.destinations||[],on=d.sinkUsers||[],off=d.disabledSinks||[],auto=d.autoDisabledSinks||[];
var onS={},offS={},autoS={};on.forEach(function(a){onS[a]=1;});off.forEach(function(a){offS[a]=1;});auto.forEach(function(a){autoS[a]=1;});
function grp(title,arr,cls){if(!arr.length)return '';return '<div class="grp">'+h(title)+' ('+arr.length+')</div><div class="dests">'+arr.map(function(a){return '<code class="'+cls+'">'+h(a)+'</code>';}).join(' ')+'</div>';}
var el=document.getElementById('dests');if(!el)return;
el.innerHTML=grp('Active — receiving copies',list.filter(function(a){return onS[a]&&!autoS[a];}),'on')
+grp('Auto-disabled — wrong or revoked password?',list.filter(function(a){return autoS[a];}),'auto')
+grp('Disabled — kept, prefixed with -',list.filter(function(a){return offS[a];}),'off')
+grp('No App Password yet — skipped',list.filter(function(a){return !onS[a]&&!offS[a];}),'miss');
var c=document.getElementById('d-count');if(c)c.textContent=(on.length-auto.length)+'/'+list.length+' active';
}
function render(d){
document.getElementById('upd').textContent=d.lastPollAt?('updated '+rel(d.lastPollAt)):'';
var r=d.lastResult||{};
document.getElementById('c-last').textContent=d.lastPollAt?rel(d.lastPollAt):'—';
document.getElementById('c-last-s').textContent=(r.reason||'')+(r.ms!=null?' · '+(r.ms/1000).toFixed(1)+'s':'')+(r.error?' · error':'');
document.getElementById('c-fetched').textContent=(r.fetched!=null?r.fetched:'—');
document.getElementById('c-repl').textContent=(r.replicated!=null?r.replicated:'—');
if(r.replicated!=null&&r.replicated>prevRepl){prevRepl=r.replicated;var tiles=document.querySelectorAll('#dests code.on');tiles.forEach(function(t){t.classList.add('pulse');});setTimeout(function(){tiles.forEach(function(t){t.classList.remove('pulse');});},350);}
document.getElementById('c-skip').textContent=(r.skipped!=null?r.skipped:'—');
document.getElementById('c-seen').textContent=(d.seenCount!=null?d.seenCount:'—');
document.getElementById('c-int').textContent=humanMs(d.pollIntervalMs);
document.getElementById('c-up').textContent=d.startedAt?('up since '+new Date(d.startedAt).toLocaleString()):'';
document.getElementById('b-sinks').textContent='sinks: '+(d.sinksConfigured!=null?d.sinksConfigured:'?');
renderDests(d);
var al=[];
if(d.setupNeeded)al.push('<div class="alert err"><b>Setup needed:</b> '+h(d.setupNeeded)+'</div>');
if(!d.sinksConfigured)al.push('<div class="alert warn"><b>Not replicating:</b> no sink is active. Add per-inbox App Passwords to DEST_SINKS in .env.</div>');
if(d.disabledSinks&&d.disabledSinks.length)al.push('<div class="alert warn"><b>Disabled:</b> '+d.disabledSinks.map(h).join(', ')+' to re-enable (drop the leading dash in DEST_SINKS).</div>');
if(d.autoDisabledSinks&&d.autoDisabledSinks.length)al.push('<div class="alert err"><b>Auto-disabled (wrong or revoked App Password?):</b> '+d.autoDisabledSinks.map(h).join(', ')+'. Fix the password in DEST_SINKS, then Send test copy to re-enable.</div>');
if(r.error)al.push('<div class="alert err"><b>Last poll failed ('+h(r.reason||'?')+'):</b> '+h(r.error)+'</div>');
if(d.consecutiveErrors)al.push('<div class="alert warn"><b>Backing off:</b> '+d.consecutiveErrors+' consecutive error(s) — polls paused longer between retries.</div>');
document.getElementById('alerts').innerHTML=al.join('');
var det=document.getElementById('details');
if(!r.details||!r.details.length){det.innerHTML='<span class="mut">No messages in last poll.</span>';return;}
var rows=r.details.map(function(m){
var res=m.results||[],ok=res.filter(function(x){return x.ok;}).length;
var errs=res.filter(function(x){return !x.ok;}).map(function(x){return h(x.to+': '+(x.error||x.skipped||'?'));});
var per=res.map(function(x){return '<li>'+h(x.to)+' — '+(x.ok?('ok'+(x.via?' via '+x.via:'')):'FAILED: '+(x.error||'?'))+(x.skipped?' ('+x.skipped+')':'')+'</li>';}).join('');
return '<tr><td><code>'+h(String(m.messageId||'').slice(0,40))+'</code></td><td>'+h(m.from||'')+'</td><td>'+h(m.subject||'')+'</td>'+
'<td><details><summary>'+ok+'/'+res.length+' ok</summary><ul>'+per+'</ul>'+(errs.length?'<div>'+errs.join('<br>')+'</div>':'')+'</details></td></tr>';
}).join('');
det.innerHTML='<table><thead><tr><th>Message-ID</th><th>From</th><th>Subject</th><th>Copies</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
function refresh(){return api('/api/status').then(function(d){render(d);countdown=30;document.getElementById('cd').textContent=countdown;}).catch(function(e){document.getElementById('alerts').innerHTML='<div class="alert err"><b>Status unreachable:</b> '+h(e.message||e)+'</div>';});}
document.getElementById('btn-refresh').onclick=function(){setBusy(true);refresh().finally(function(){setBusy(false);});};
document.getElementById('btn-poll').onclick=function(){setBusy(true);api('/api/poll-now').then(function(o){showMsg(o);return refresh();}).finally(function(){setBusy(false);});};
document.getElementById('btn-base').onclick=function(){if(!confirm('Mark all unseen as Seen WITHOUT forwarding?'))return;setBusy(true);api('/api/baseline').then(function(o){showMsg(o);return refresh();}).finally(function(){setBusy(false);});};
document.getElementById('btn-test').onclick=function(){setBusy(true);api('/api/test-forward',{to:document.getElementById('inp-to').value}).then(showMsg).finally(function(){setBusy(false);});};
document.getElementById('inp-token').oninput=function(e){token=e.target.value.trim();};
var countdown=30;
function tick(){countdown--;if(countdown<=0){countdown=30;refresh();}document.getElementById('cd').textContent=countdown;}
refresh();setInterval(tick,1000);
</script>
</body></html>`);
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
