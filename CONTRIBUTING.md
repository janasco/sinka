# Contributing to sinka

Thanks for stopping by — issues and pull requests are welcome.

## Quick run

```bash
cp .env.example .env   # fill in your own test values, never commit it
npm install
npm run check          # syntax check — run before every PR
npm test               # unit tests — must pass before every PR
npm run poll-once      # single poll, safe way to test changes
```

Please don't commit `.env`, `data/seen.json`, or any log files.

## Settings (key names only — never paste values)

All settings live in `.env` locally (see `.env.example`) or as Worker
secrets on the edge. Required: `GMAIL_USER`, `GMAIL_APP_PASSWORD`,
`DEST_SINKS`, `FORWARD_LIST`. Edge also needs `CLOUDFLARE_ACCOUNT_ID`,
`D1_DATABASE_ID`, `CLOUDFLARE_API_TOKEN`, `ADMIN_TOKEN`.
Optional: `ALERT_NTFY_TOPIC` + `ALERT_THRESHOLD` (outage buzz via
ntfy.sh, empty topic = off), `APPEND_CONCURRENCY` (cap parallel
copies, unset = all at once), `CATCHUP_LIMIT` (default 25),
`POLL_INTERVAL_MS` (default 300000 on the edge, 60000 with no
`.env` value), `ADMIN_TOKEN` (empty = rely on Cloudflare Access alone).

The container only receives the settings listed in the `envVars`
allow-list in `worker.js`. A key set as a Worker secret but missing
from that list never reaches the poller, so add it there in the same
PR.

Use placeholders in docs/issues (`you@example.com`,
`team@example.com`, `sinka.example.com`, `REPLACE_ME_*`) — never
real addresses, IDs, or hostnames.

## What to check before a PR

Dashboard (keep the page's own wording):
- The verdict line at the top still reads correctly for each state
  (working / N inboxes need help / no team inboxes / setup needed /
  last check failed / starting up) and still says "Can't reach sinka"
  when `/api/status` cannot be reached, with the numbers below frozen
  rather than left looking live.
- Section names: "What it is doing right now", "What the last check
  found", "Things you can do", "What just happened", "Start here".
- Tile groups and colors: Copying right now (green), Sign-in failed,
  waiting for you (red), Paused by you (gray), No sign-in details yet
  (amber), Trying again (purple). The source dot is green / red / gray
  for finished / failed / unreachable.
- The 30s countdown is the page redraw only, and the page says so; the
  real check interval (`POLL_INTERVAL_MS`) is shown separately as
  "Checks every".
- Buttons: "Check for mail now", "Refresh the numbers", "Send a test
  copy", "Skip the backlog" (confirm-first, cannot be undone), plus the
  private-token field.
- The "Start here" checklist still only states what is really true.
- `GET /api/status` fields (`sinkUsers`, `disabledSinks`,
  `autoDisabledSinks`, `pendingSinks`).
- Copy logic: IMAP APPEND only, retry queue (`pendingSinks`) still
  drains on the next poll, cron stays `*/5 * * * *` in step with
  `POLL_INTERVAL_MS`, and the free `workers.dev` address stays off.

## Pull requests

- Keep the change small and focused; one thing per PR.
- Describe what you changed and how you tested it
  (`npm run check`, `npm test`, `npm run poll-once`, edge test if relevant).
- Don't reintroduce SMTP/sending — this project is IMAP APPEND only.
- Don't add new `*_TOKEN` env keys without discussing first.

## Commit style

Short, human commit messages (e.g. `fix poll loop on empty inbox`).
No strict convention — just keep it readable.

## RULE: no AI co-authorship

- Do NOT add `Co-Authored-By` trailers for bots
  (Claude, OpenCode, ChatGPT, Copilot, etc.).
- Do NOT add `Generated-by` markers or robot emojis.
- AI is never added as a contributor or author — humans only.
  AI may help you write code locally, but the commit and PR must read
  as your own work.

Questions? Open an issue — happy to help.
