import { Container } from '@cloudflare/containers';
import { env } from 'cloudflare:workers';

// Single replicator instance. Scale to 1: all routes use getByName("replicator").
// The container runs the poller on its own setInterval, so once started it
// stays up doing its job; cron (every 5m) also wakes it after any restart.
// Secrets come from Worker Secrets (`wrangler secret put ...`), plain
// config from [vars] in wrangler.toml. GITHUB_TOKEN_* stays local only.
export class ReplicatorContainer extends Container {
  defaultPort = 8788;
  // Environment contract: the container receives ONLY the keys listed in
  // containerEnv() below. A Worker secret or [vars] key that is not in that
  // list never reaches the poller, so the feature stays silently inert on
  // the edge — when src/*.js starts reading a new setting, add it there in
  // the same change. Every value needs an `?? '<default>'` fallback so the
  // start call never receives undefined. GITHUB_TOKEN_* is deploy/ops only
  // and deliberately absent.
  containerEnv() {
    // Module-level env (not this.env): resolves per request, always populated.
    return {
      GMAIL_USER: env.GMAIL_USER ?? '',
      GMAIL_APP_PASSWORD: env.GMAIL_APP_PASSWORD ?? '',
      FORWARD_LIST: env.FORWARD_LIST ?? '',
      POLL_INTERVAL_MS: env.POLL_INTERVAL_MS ?? '300000',
      LOOKBACK_HOURS: env.LOOKBACK_HOURS ?? '24',
      DEST_SINKS: env.DEST_SINKS ?? '',
      PORT: env.PORT ?? '8788',
      DATA_DIR: env.DATA_DIR ?? './data',
      ADMIN_TOKEN: env.ADMIN_TOKEN ?? '',
      DRY_RUN: env.DRY_RUN ?? '0',
      CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID ?? '',
      D1_DATABASE_ID: env.D1_DATABASE_ID ?? '',
      CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN ?? '',
      // Outage alert via ntfy.sh: empty topic = disabled.
      ALERT_NTFY_TOPIC: env.ALERT_NTFY_TOPIC ?? '',
      // Consecutive failed polls before the alert fires (src/index.js: 3).
      ALERT_THRESHOLD: env.ALERT_THRESHOLD ?? '3',
      // Max parallel IMAP APPENDs per fan-out; default 3 (src/mail.js).
      // Explicit 0 = unlimited.
      APPEND_CONCURRENCY: env.APPEND_CONCURRENCY ?? '3',
      // Max messages pulled per poll; the backlog drains oldest-first.
      POLL_BATCH_LIMIT: env.POLL_BATCH_LIMIT ?? '5',
      // Outage email via Resend (all three required, else disabled).
      RESEND_API_KEY: env.RESEND_API_KEY ?? '',
      ALERT_EMAIL_TO: env.ALERT_EMAIL_TO ?? '',
      ALERT_EMAIL_FROM: env.ALERT_EMAIL_FROM ?? '',
      // Optional public status URL quoted in the outage email.
      ALERT_STATUS_URL: env.ALERT_STATUS_URL ?? '',
      // Days of poll history kept for /status (data/history.json pruning).
      RETENTION_DAYS: env.RETENTION_DAYS ?? '30',
      // First-run UNSEEN backlog cap; above it the inbox is baselined
      // instead of blasted (src/index.js: 25).
      CATCHUP_LIMIT: env.CATCHUP_LIMIT ?? '25',
    };
  }
  // Durable-object scheduling policy: the platform does NOT start instances
  // on its own — first request starts it explicitly, then proxies. Started
  // instances run until the app is recreated (no idle sleep: the poller's
  // own setInterval is the heartbeat, and cron wakes it after any restart).
  async fetch(request) {
    try {
      if (!this.ctx.container.running) {
        await this.ctx.container.start({
          image: this.ctx.container.images.replicator,
          instance: 'lite',
          enableInternet: true,
          env: this.containerEnv(),
        });
      }
    } catch (err) {
      return new Response('Container failed to start: ' + (err?.message || String(err)), { status: 502 });
    }
    return this.containerFetch(request);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health straight from the edge (does not wake the container).
    if (url.pathname === '/edge-healthz') {
      return Response.json({ ok: true, edge: true });
    }

    // Singleton: one container owns the Gmail IMAP polling loop.
    const container = env.REPLICATOR.getByName('replicator');
    return container.fetch(request);
  },

  // Cron wakes the container for a poll even with zero HTTP traffic.
  // Matches POLL_INTERVAL_MS (see [triggers] crons in wrangler.toml).
  // Passes the admin bearer so cron keeps working when ADMIN_TOKEN is set
  // (requireAdmin would otherwise 401 it).
  async scheduled(_event, env, _ctx) {
    const container = env.REPLICATOR.getByName('replicator');
    const headers = env.ADMIN_TOKEN
      ? { Authorization: 'Bearer ' + env.ADMIN_TOKEN }
      : undefined;
    await container.fetch(
      new Request('http://internal/api/poll-now', { method: 'POST', headers })
    );
  },
};
