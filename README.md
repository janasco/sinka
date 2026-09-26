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
  this on its own timer (`POLL_INTERVAL_MS`, 5 minutes by default),
  like glancing at the mailbox. This is separate from the 30-second
  redraw of the dashboard page itself.
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
**Send a test copy** to file one labeled test letter into every
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
   The free `workers.dev` address stays off (`workers_dev = false`
   in `wrangler.toml`), so the dashboard lives only on your address.

The alarm clock (cron `*/5 * * * *`) wakes the app every 5 minutes,
matching `POLL_INTERVAL_MS=300000`, and the D1 notebook remembers
copied letters. Full step-by-step runbook: **`DEPLOY_EDGE.md`**.

Two safety rules:
- Never run the edge copy AND your home computer copy at the same
  time — both would copy the same letters twice.
- After moving, press **Skip the backlog** once: it marks old unread
  mail as read without copying, so only truly new mail gets copied.

## The dashboard, in plain words

The page gives you one plain sentence at the top, then shows the
working underneath. Read it from the top down.

### 1. The answer at the top

One line, always one of these:

- "Everything is working."
- "N inboxes need your help" / "1 inbox needs your help" — a sign-in
  was refused.
- "No team inboxes yet" — nothing is listed to copy into.
- "One more step needed" — sinka itself is not signed in yet.
- "The last check did not finish" — sinka is waiting and trying again
  on its own, a little longer each time.
- "Starting up" / "Waiting for the first check" — nothing has run yet.

Next to it, **"This page updates in 30s" is only this page redrawing
itself.** It never triggers a mail check. sinka checks the mail on its
own timer, shown right below as "sinka checks mail every", and again in
the numbers as "Checks every". If you change `POLL_INTERVAL_MS`, that
is the number that changes — not the 30.

Under the answer, **alerts** appear in plain words when something needs
you: one more step needed, nothing being copied yet, paused on purpose,
sign-in was refused, the last check did not finish, being patient (it
waits longer between tries, up to an hour), or no team inboxes listed.

**If the page ever loses the server**, the answer becomes "Can't reach
sinka — the numbers below may be out of date", the dot by the source
inbox turns gray, and everything below is dimmed and frozen with a red
note saying the numbers stopped moving and are the last ones that
really arrived. The page keeps trying every 30 seconds, and says
"Reconnected — these numbers are live again" when it does. Nothing
below is allowed to look live while that is going on.

### 2. What it is doing right now

One inbox on top, then one tile per team inbox underneath:

- The top row is the source inbox, with a dot: green means the last
  check finished, red means it failed, gray means this page cannot
  reach sinka. The label beside it says which.
- Tiles are grouped, and the group titles are the color legend:
  - **Copying right now** — green.
  - **Sign-in failed, waiting for you** — red. Three failed copies in a
    row (wrong or revoked password) and copying is paused there. Fix
    the password, then choose **Send a test copy** to switch it back on.
  - **Paused by you** — gray. A `-` in front of the address in
    `DEST_SINKS` keeps the password but stops the copies.
  - **No sign-in details yet** — amber. The address is in
    `FORWARD_LIST` but has no `DEST_SINKS` entry, so sinka has nothing
    to sign in with. Needs you.
  - **Trying again** — purple. One tile per queued copy, showing how
    many tries it has had. Queued copies go out again on the next
    check, up to 5 tries, and are then written to
    `data/failures.log` instead of being lost quietly.
- Each tile carries a count and a small sparkline of the last minute.
  A count only ever rises when a copy really lands, so a fresh page
  starts every tile at zero. Counts belong to the page you are looking
  at, not to all of time — the lifetime figure is "Remembered" in the
  next section.

### 3. What the last check found

When the last check finished (and how long it took), new mail found,
copies filed, skipped (already filed, or automatic replies), remembered
(never copied twice), and how often checks run. Nothing here is
estimated: a number fills in only when the real thing happened.

### 4. Things you can do

Everyday actions first, the one that cannot be undone kept separate:

- **Check for mail now** — look for new mail straight away instead of
  waiting for the timer.
- **Refresh the numbers** — redraw the page with the newest
  information.
- **Send a test copy** — one clearly labelled test message into every
  active inbox, and the quickest way to prove a repaired password
  works.
- **Skip the backlog** (marked Careful) — mark everything currently
  unread in the source inbox as read and copy none of it. It asks you
  to confirm first, and cannot be undone.
- **The private token box is step 1 of that list.** Some installs sit
  behind an extra sign-in; paste `ADMIN_TOKEN` there and the buttons —
  and the page's own 30-second redraw — work. It is kept in that
  browser tab only, never written to disk. Leave `ADMIN_TOKEN` empty
  to rely on the Access lock alone. On the edge, the alarm clock sends
  the token itself so automatic checks keep working.

Whatever you press, the answer comes back under the list in plain
words, with the raw server reply folded away for whoever runs the
install. Buttons grey out while a job is running, so two cannot
overlap.

### 5. What just happened

The messages from the most recent check, newest first: subject, who it
came from, and "N of M filed" with the per-inbox detail folded away.
Nothing here is listed unless the last check really did something.

### 6. Start here

A three-item checklist that ticks itself as sinka really gets going:

1. sinka is signed in to the source inbox.
2. Team inboxes can sign in (it counts them, e.g. "8 of 10 inboxes can
   sign in").
3. A copy has really landed.

With no answer from sinka it says it cannot say yet, instead of
guessing. "Read the longer guide" behind the checklist explains what
sinka does, what the colors mean, and what each button does. Hide it
with "Got it, hide this"; reopen it any time with the **Guide** button
in the footer.

### Also worth knowing

- Outage alerts: when checks keep failing, sinka sends one phone
  buzz via ntfy.sh. Set `ALERT_NTFY_TOPIC` and `ALERT_THRESHOLD`
  in `.env` (see `.env.example`); empty topic = no alerts. The same
  two keys can go on the edge as optional Worker secrets
  (`npx wrangler secret put ALERT_NTFY_TOPIC` / `ALERT_THRESHOLD`),
  but the poller only sees what the container is handed, so both keys
  must also be listed in the allow-list in `worker.js` first.
- Gentler copying (optional): set `APPEND_CONCURRENCY=N` to copy
  into at most N inboxes at once. Leave it unset for all-at-once,
  which is today's behavior. Same allow-list caveat as above on the
  edge.
- Practice mode: with `DRY_RUN=1` the page carries a "Practice mode"
  badge and nothing is really copied.
- Before sending changes, run `npm test` (plus `npm run check`)
  so the dashboard and copy logic stay green.

## Help out

Found a bug or want a feature? Open an issue or send a pull
request — see **`CONTRIBUTING.md`**. One rule: no AI-written
credits in commits; humans only.
