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

All identifying values are Worker secrets (a same-named `[vars]`
entry would block the secret, so `[vars]` keeps only generic tuning:
`POLL_INTERVAL_MS`, `LOOKBACK_HOURS`, `PORT`, `DATA_DIR`, `DRY_RUN`).

```bash
npx wrangler secret put GMAIL_USER
npx wrangler secret put GMAIL_APP_PASSWORD
npx wrangler secret put DEST_SINKS
npx wrangler secret put FORWARD_LIST
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put D1_DATABASE_ID
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put ADMIN_TOKEN
```

`GITHUB_TOKEN_*` stays local only (deploy/ops), never as a Worker secret.

The container only gets the keys listed in `envVars` in `worker.js`.
A secret set but not listed there never reaches the poller — add it to
that list in the same change (this applies today to
`ALERT_NTFY_TOPIC`, `ALERT_THRESHOLD`, `APPEND_CONCURRENCY` and
`CATCHUP_LIMIT`, which are not in the list yet).

## 3. Deploy

Option A — Workers Builds (recommended, no Docker):

1. Dashboard → Workers & Pages → Create → Connect Git →
   your repo, build `npx wrangler deploy`.
2. Wait for container provisioning (several minutes on first deploy).

Option B — local Docker:

```bash
docker info  # must succeed
npm run deploy            # plain npx wrangler deploy
npx wrangler containers list  # wait until healthy
```

Apply the D1 schema once:

```bash
npm run d1:schema
```

### Secret or `wrangler.toml` changes (needs a fresh container)

The singleton container reads its settings when it is created, so a new
secret or a `[vars]` change stays invisible until it is recreated. Order
still matters — secrets first, recreate second:

```bash
npx wrangler secret put GMAIL_USER   # ...every changed key, before recreating
npm run redeploy                    # deploy, delete the container, deploy, verify
```

`npm run redeploy` resolves the one application named
`sinka-replicatorcontainer` and refuses to continue if the match is not
exactly one. It stops the poller for ~1-2 min, then waits up to 3 min for
the new container to report `running`. Preview it first with
`npm run redeploy -- --dry-run` (changes nothing) and pass `--yes` to skip
the confirmation. It only proves the process is up and the port answers,
not that replication is healthy — check `/api/status` afterwards. To roll
back, redeploy the previous Worker version; the container picks it up on
the next recreate.

## 4. Route + Access cutover

```bash
npx wrangler route add sinka.example.com/* sinka
```

- Keep a Zero Trust Access app on your hostname
  (Email OTP, e.g. `you@example.com` only).
- Test incognito: OTP → dashboard → `/api/status`
  (`sinksConfigured: N`, `seenCount`, `pendingSinks`).
  With `ADMIN_TOKEN` set, paste it into the "Things you can do" token
  box before pressing **Check for mail now**, **Send a test copy** or
  **Skip the backlog** — the box is kept in that browser tab only.
- The "This page updates in 30s" countdown is only the page redraw; the
  real check interval is `POLL_INTERVAL_MS`, shown as "Checks every".
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
  (`POST /api/baseline`). If a weekly dump exists, restoring it is better —
  see section 7.

## 7. D1 backup (optional, weekly in CI)

`seen` is the one thing Sinka cannot rebuild from the mailbox: it records
which message IDs have already been replicated, so losing it means re-filing
mail that was already copied. The container keeps no local copy — once D1 is
configured, `data/seen.json` is unused.

`.github/workflows/backup.yml` runs `scripts/export-d1-backup.mjs` every
Monday 04:23 UTC, and on demand from the Actions tab (**D1 backup** →
**Run workflow**). The JSON is attached to the run as an artifact, kept 90
days. Nothing is deployed, pushed or deleted.

The workflow is optional: until the three settings below exist it checks them,
prints a notice naming what is missing and skips itself — a green run, not a
red one. It can also be deleted without touching anything else.

**What a backup contains:** the whole `seen` table as
`[{ "id": ..., "seen_at": ... }, ...]`, ordered by `seen_at` — tens of KB.
Message IDs and when they were filed. Nothing else: no mail, no sink list, no
Worker secrets.

### Settings to add

GitHub → repo **Settings** → **Secrets and variables** → **Actions**.

| What | Where | Name |
| --- | --- | --- |
| API token, **D1 read only** | Secrets → *New repository secret* | `D1_EXPORT_TOKEN` |
| Account id | Variables → *New repository variable* | `CLOUDFLARE_ACCOUNT_ID` |
| `sinka-seen` database id | Variables → *New repository variable* | `D1_DATABASE_ID` |

Those three, nothing else. Ids in variables, not secrets: they are not
credentials, and the export script keeps them out of its own output anyway.

Mint the token as a **separate, read-only** API token (Cloudflare → My
Profile → **API Tokens** → Create → *Read* → Account → **D1**), not the token
the Worker runs on. It only ever runs a `SELECT`, and revoking it can never
take the poller down.

### Run it locally

```bash
node --env-file=.env scripts/export-d1-backup.mjs --dry-run   # count only
node --env-file=.env scripts/export-d1-backup.mjs --out /tmp/sinka-seen.json
```

`--env-file` is Node's own flag: the script reads the environment and nothing
else, so no `.env` value is ever picked up implicitly and no id is hard-coded
in it. It prints page count, `rows:`, byte size and the output path, then
exits. `--dry-run` runs the same queries and prints the same counts but writes
nothing.

Any D1 error exits non-zero with the API's own message, with the token (and
anything else token-shaped) redacted first. Exit codes: `1` missing env or bad
flag, `2` D1 API error, `3` could not write the file. An empty table is not an
error — it writes a valid `[]`.

Default output is `backups/sinka-seen-<UTC timestamp>.json`. `backups/` is not
in `.gitignore`, so pass `--out` outside the repo for local runs (as above) or
delete the directory before committing.

### Getting a dump back into D1

Artifacts sit on the run page for 90 days; download anything worth keeping
past that. To re-seed `seen` from a dump:

```bash
node --input-type=module -e "$(cat <<'EOF'
import fs from 'node:fs';
const rows = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const q = (s) => String(s).replace(/'/g, "''");
const sql = rows.map((r) => `INSERT OR IGNORE INTO seen (id, seen_at) VALUES ('${q(r.id)}', '${q(r.seen_at)}');`).join('\n');
process.stdout.write(`BEGIN;\n${sql}\nCOMMIT;\n`);
EOF
)" sinka-seen.json > restore.sql
npx wrangler d1 execute sinka-seen --remote --file=./restore.sql
```

`INSERT OR IGNORE` means a restore never duplicates rows and never overwrites
newer `seen_at` values, so re-running it is safe. Keep in mind the poller only
holds the newest ~6000 ids in memory (`src/store_d1.js`), so a restore mostly
protects recent mail; older rows are just history.
