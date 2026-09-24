import { Container } from '@cloudflare/containers';
import { env } from 'cloudflare:workers';

// Single replicator instance. sleepAfter="never" keeps the 24/7 IMAP
// poller alive (its own setInterval drives polling, not inbound traffic).
// Scale to 1: all routes use getByName("replicator").
// Secrets come from Worker Secrets (`wrangler secret put ...`), plain
// config from [vars] in wrangler.toml. GITHUB_TOKEN_* stays local only.
export class ReplicatorContainer extends Container {
  defaultPort = 8788;
  // No "never" in this SDK — cron (every 5m) + internal interval keep it
  // warm; 30m idle timeout covers cron jitter without sleeping mid-poll.
  sleepAfter = '30m';
  envVars = {
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
  };
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
