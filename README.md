# sinka — one inbox in, many inboxes out

Imagine one mailbox at the office receives all the letters. Sinka reads
each new letter and drops an exact copy into every team member's own
mailbox. Nobody forwards anything, nobody shares passwords — everyone
just finds the mail already in their inbox.

> Sinka is an open-source **alternative to Gmailify** for teams.
> Gmailify pulls many addresses into *one* Gmail account; sinka does
> the opposite — it fans *one* Gmail inbox out to *many* real inboxes.

How it copies: it never *sends* mail like a person would. It files a
byte-for-byte copy straight into each inbox (the same thing the
Thunderbird mail app does when you drag a message between accounts).
That means no daily sending limits, and nothing to fail about stamps
and signatures (DKIM/SPF).

## Hard words, made easy

- **Inbox** — an email account, like `you@example.com`.
- **Source inbox** — the one mailbox that receives everything first.
- **Destination inbox (sink)** — a team mailbox that gets a copy.
- **IMAP** — the standard language mail apps use to read mailboxes.
  Sinka speaks it, so Gmail just thinks it's another mail app.
- **App Password** — a special 16-letter code Gmail makes for one app.
  It is NOT your normal Gmail password. One code per inbox.
- **Poll** — sinka checking the source inbox for new mail. It does
  this automatically every 5 minutes, like glancing at the mailbox.
- **Edge** — instead of your own computer running day and night,
  the app lives on Cloudflare's computers around the world, always on.
- **Worker / Container** — small pieces of your app running on the
  edge. Think: the worker is the front door, the container is the
  back room doing the copying.
- **D1** — a tiny notebook on the edge where sinka writes down which
  letters it already copied, so it never copies twice.
- **Subdomain** — your own web address for the dashboard, like
  `sinka.example.com`.
- **Access + OTP** — a lock on the dashboard: visitors must type a
  one-time code emailed to them before they can look. Only people
  you allow get in.
- **Cron** — an alarm clock on the edge that wakes the app every
  5 minutes so it checks mail even when nobody visits the dashboard.
- **`.env`** — a private settings file on your computer. Passwords
  live here. It is never uploaded to GitHub.

## What you need

1. A computer with **Node.js 20 or newer** (check: `node --version`).
2. The source Gmail inbox, plus every team inbox.
3. For each inbox: turn on **IMAP** (Gmail Settings > See all
   settings > Forwarding and POP/IMAP > Enable IMAP > Save), turn on
   **2-Step Verification**, then make one **App Password** (Google
   Account > Security > App passwords, name it `sinka`).
4. For edge hosting: a Cloudflare account with the **Workers Paid**
   plan.

## Set it up (10 minutes)

**Step 1 — get the code and install the pieces.**
```bash
git clone https://github.com/janasco/sinka.git
cd sinka
npm install
```

**Step 2 — write your private settings.**
```bash
cp .env.example .env
```
Open `.env` in any text editor and fill in:
- `GMAIL_USER` — your source inbox address.
- `GMAIL_APP_PASSWORD` — the 16-letter code for the source inbox
  (letters only, spaces don't matter).
- `DEST_SINKS` — one `address:code` pair per team inbox, joined
  with `;`. Example:
  `team-a@example.com:xxxx xxxx xxxx xxxx;team-b@example.com:yyyy yyyy yyyy yyyy`
  Put a `-` in front of an address to pause it without deleting
  its password.

**Step 3 — try one check.**
```bash
npm run check        # makes sure the code has no typos
npm run poll-once    # checks mail once and stops — safe to test
```

**Step 4 — run it.**
```bash
npm start
```
Open http://localhost:8788 — you should see the dashboard. Press
**Send test copy** to file one labeled test letter into every
active inbox and confirm it arrives.

## Run it day and night (edge hosting)

Instead of leaving your computer on forever, put sinka on
Cloudflare's edge:

1. Save each password as a secret (you type the value when asked,
   it is never written into files):
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
2. Launch it:
   ```bash
   npx wrangler deploy
   ```
3. Give it your own address: add a route for your subdomain
   (e.g. `sinka.example.com/*`) pointing at the `sinka` worker.
4. Put the Access lock on that address (Email OTP, only addresses
   you allow). Now the dashboard asks visitors for a code first.

The alarm clock (cron) is already set to every 5 minutes, and the
D1 notebook remembers copied letters. Full step-by-step runbook:
**`DEPLOY_EDGE.md`**.

Two safety rules:
- Never run the edge copy AND your home computer copy at the same
  time — both would copy the same letters twice.
- After moving, press **Skip backlog** once: it marks old unread
  mail as read without copying, so only truly new mail gets copied.

## The dashboard, in plain words

- Hero strip on top tells you the state: flowing normally, inbox(es)
  need attention, setup needed, last check failed, or starting up.
- **Pipeline**: source inbox → moving dots → team tiles. Green tile
  = copying. Gray = paused (`-` in front). Amber = needs a password.
  Red = auto-disabled after repeated copy failures (wrong or revoked
  password — fix it, then Send test copy to re-enable).
- **Retrying** (amber) group is the retry queue: copies that failed
  part-way wait here with a try count and go out again on the next
  check, so nothing is silently dropped.
- **Check now** looks for mail immediately. **Skip backlog** marks
  old mail read without copying. Numbers count down to the next
  automatic check.
- Outage alerts: when checks keep failing, sinka sends one phone
  buzz via ntfy.sh. Set `ALERT_NTFY_TOPIC` and `ALERT_THRESHOLD`
  in `.env` (see `.env.example`); empty topic = no alerts.
- Before sending changes, run `npm test` (plus `npm run check`)
  so the dashboard and copy logic stay green.

## Help out

Found a bug or want a feature? Open an issue or send a pull
request — see **`CONTRIBUTING.md`**. One rule: no AI-written
credits in commits; humans only.
