# Edge deploy runbook — Containers + D1

No tunnel, no LAN box. Worker fronts your subdomain
(e.g. `sinka.example.com`), singleton container runs the IMAP poller,
D1 replaces `seen.json`.

## 1. Prerequisites

- Workers Paid plan (Containers require it).
- Either Docker locally (for `wrangler deploy`) or Workers Builds
  connected to your repo (no local Docker needed).
- Account ID: `REPLACE_ME_CLOUDFLARE_ACCOUNT_ID`.
- D1 database ID: `REPLACE_ME_D1_DATABASE_ID` (see `wrangler.toml`).

## 2. Secrets (never commit)

```bash
npx wrangler secret put GMAIL_USER
npx wrangler secret put GMAIL_APP_PASSWORD
npx wrangler secret put DEST_SINKS
npx wrangler secret put CLOUDFLARE_API_TOKEN
# Plain vars (not secret) — set in wrangler.toml [vars]:
# CLOUDFLARE_ACCOUNT_ID=REPLACE_ME_CLOUDFLARE_ACCOUNT_ID
# D1_DATABASE_ID=REPLACE_ME_D1_DATABASE_ID
# FORWARD_LIST, POLL_INTERVAL_MS=300000, LOOKBACK_HOURS=24, PORT=8788
```

`GITHUB_TOKEN_*` stays local only (deploy/ops), never as a Worker secret.

## 3. Deploy

Option A — Workers Builds (recommended, no Docker):

1. Dashboard → Workers & Pages → Create → Connect Git →
   your repo, build `npx wrangler deploy`.
2. Wait for container provisioning (several minutes on first deploy).

Option B — local Docker:

```bash
docker info  # must succeed
npx wrangler deploy
npx wrangler containers list  # wait until healthy
```

Apply the D1 schema once:

```bash
npm run d1:schema
```

## 4. Route + Access cutover

```bash
npx wrangler route add sinka.example.com/* sinka
```

- Keep a Zero Trust Access app on your hostname
  (Email OTP, e.g. `you@example.com` only).
- Test incognito: OTP → dashboard → `/api/status`
  (`sinksConfigured: N`, `backend: d1` once D1 IDs are set).
- `POST /api/test-forward {"to":"team-a@example.com"}`.

## 5. Retire the old path (only after edge is green)

1. Remove the legacy tunnel ingress pointing at
   `http://REPLACE_ME_LAN_IP:8788` (if you migrated from a LAN box).
2. Stop and disable the old systemd service on the LAN host
   (`systemctl stop sinka && systemctl disable sinka`).
   Never run edge + LAN pollers together (double-filed copies).

## 6. Rollback

- Re-add tunnel ingress → `http://REPLACE_ME_LAN_IP:8788`,
  re-enable the systemd service on the LAN host.
- File fallback resumes automatically (D1 IDs absent locally).
- To re-seed D1 from file later:
  `sqlite3` → `INSERT OR IGNORE INTO seen (id) VALUES (?)` per line of
  `data/seen.json`, or just let the edge baseline once
  (`POST /api/baseline`).
