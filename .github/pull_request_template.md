<!--
Keep it short and honest. Contributors should know exactly what to tick.
-->

## What changed

<!-- One or two lines: what this PR does and why. -->

## How I tested it

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run poll-once` — required if you touched the mail, IMAP or poll
      paths; it is the safe way to exercise a real single poll
- [ ] Deployed edge Sinka — only if you touched `worker.js` or the container

## Docs

- [ ] Updated `README.md`, `DEPLOY_EDGE.md` or `CONTRIBUTING.md` if behaviour,
      settings or the workflow changed
- [ ] No docs needed

## House rules

- **Commits must be human-authored, with no AI co-author trailers.** Do not add
  `Co-Authored-By` trailers for bots, `Generated-by` markers or robot emoji.
  Tooling may help you write the code locally, but the history and this PR read
  as your own work. See `AGENTS.md` and `CONTRIBUTING.md`.
- **Never commit `.env` or `data/seen.json`** (or any `*.log`). Double-check the
  diff before you push.
- One thing per PR, and keep it small.
- Sinka is IMAP APPEND only — do not reintroduce sending paths.
- No secret values, real email addresses, hostnames or account IDs anywhere in
  the diff, the commits or the description. Placeholders only.
