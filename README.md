# sinka — Gmail inbox replicator

Sinka (from "sinks", `DEST_SINKS`): polls one Gmail inbox via **IMAP**
and files each new message straight into multiple team inboxes via
**IMAP APPEND** (Thunderbird-style copy).

> An open-source **alternative to Gmailify** for teams: instead of
> linking external addresses into one Gmail account, sinka fans one
> source inbox out to many real inboxes — each member works from their
> own mailbox, no forwarding rules or shared passwords needed.

> Everything is IMAP — fetch from the source, APPEND into each
> destination. Nothing is ever sent as mail, so there are no Gmail
> sending limits and DKIM/SPF can never fail. Each inbox needs its own
> App Password (see `DEST_SINKS` in `.env.example`).

You can run it locally (plain Node) or at the **edge** (Cloudflare
Worker + Containers + D1 for dedupe state).

## Prerequisites

- **Node.js 20+** and npm.
- **Gmail App Passwords**: source inbox + each destination inbox needs
  IMAP enabled and 2-Step Verification ON, then one App Password per
  inbox (Google Account > Security > App passwords). Never use your
  normal Gmail password.
- **For edge deploy**: a Cloudflare account with the **Workers Paid**
  plan (Containers require it), plus `wrangler` (already a dev
  dependency) and Docker *or* Workers Builds.

## Quick start (local)

```bash
cp .env.example .env   # then edit: GMAIL_USER, GMAIL_APP_PASSWORD, DEST_SINKS
npm install
npm start              # or: npm run poll-once   (single poll, for testing)
```

1. In the source Gmail account: Settings > See all settings >
   Forwarding and POP/IMAP > IMAP access: **Enable IMAP** > Save.
2. Create an App Password (name it e.g. `sinka`) and put it in `.env`
   as `GMAIL_APP_PASSWORD`. Never commit `.env`.
3. Set `DEST_SINKS` to `user:password` pairs separated by `;`
   (e.g. `team-a@example.com:app-password;team-b@example.com:app-password`).
   Prefix an entry with `-` to disable it while keeping the password.

Check it works:

```bash
npm run check        # syntax check
npm run poll-once    # single poll, for testing
```

Endpoints (local UI, default port `8788`):

- `GET /` — dashboard (live status, poll/baseline/test actions).
- `GET /healthz` — container health. `GET /edge-healthz` — edge health.
- `GET /api/status` — last poll, counts, destinations.
- `POST /api/poll-now` — force a poll.
- `POST /api/baseline` — mark backlog Seen without forwarding.
- `POST /api/test-forward {"to":"team-a@example.com"}` — append one test
  message to the active sinks.

## Edge deploy

Production runs as a Worker (`sinka`) fronting your own subdomain
(e.g. `sinka.example.com`), with a singleton container running the
IMAP poller and D1 replacing `data/seen.json`.

```bash
npx wrangler deploy
```

Secrets (never commit, no values in repo):

```bash
npx wrangler secret put GMAIL_USER
npx wrangler secret put GMAIL_APP_PASSWORD
npx wrangler secret put DEST_SINKS
npx wrangler secret put CLOUDFLARE_API_TOKEN
```

Plain config lives in `wrangler.toml`
(`FORWARD_LIST`, `POLL_INTERVAL_MS`, `D1_DATABASE_ID`, …).

Then add a route for your subdomain and put a Cloudflare Access
(Email OTP) app in front of it. Full runbook: **`DEPLOY_EDGE.md`**.

Notes:

- Never run edge + a local poller against the same source inbox at the
  same time — both would poll it and double-file copies.
- `POST /api/baseline` after a cutover marks any backlog Seen without
  forwarding, so only genuinely new mail gets replicated.

## Contributing

Issues and PRs welcome — see **`CONTRIBUTING.md`**.
Maintainer rules live in `AGENTS.md` (public contributor rules);
`private/` holds maintainer-only checklists (placeholders only,
no secrets).
