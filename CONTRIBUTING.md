# Contributing to sinka

Thanks for stopping by — issues and pull requests are welcome.

## Quick run

```bash
cp .env.example .env   # fill in your own test values, never commit it
npm install
npm run check          # syntax check — run before every PR
npm run poll-once      # single poll, safe way to test changes
```

Please don't commit `.env`, `data/seen.json`, or any log files.

## Pull requests

- Keep the change small and focused; one thing per PR.
- Describe what you changed and how you tested it
  (`npm run check`, `npm run poll-once`, edge test if relevant).
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
