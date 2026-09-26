---
name: Bug report
about: Something in Sinka does not behave the way the docs say it should
title: "[bug]: "
---

<!--
Please keep this short. A tight report is much faster to fix than a long one.
If you are not sure whether it is a bug, an issue is still the right place to ask.
-->

## Title

Use the `[bug]:` prefix, then a few words in the imperative, for example
`[bug]: poll loop stalls after an empty inbox`.

## What I expected

<!-- The behaviour you expected, in one or two sentences. -->

## What happened instead

<!-- The behaviour you got, including the exact wording of any message. -->

## How to reproduce

1.
2.
3.

## Where I saw it

- [ ] Local (`npm start` / `npm run poll-once`)
- [ ] The deployed Sinka (edge)
- [ ] Somewhere else:

## Details

- Node version (`node -v`):
- Operating system:
- Sinka version or commit, if you know it:

## Output

<!-- Paste only the relevant lines, and only after redacting them. -->

```
```

## Redaction — please read before pasting anything

**Never include real credentials or personal data.** Sinka handles sign-in
secrets and mailbox addresses, so this is the part that matters most.

- No tokens, API keys or `*_TOKEN` values.
- No Gmail App Passwords, in any form, not even partially.
- No `.env` file contents — paste the key *names* only.
- No real email addresses, hostnames, account IDs, database IDs or IPs.
  Replace them with placeholders such as `you@example.com`, `team@example.com`
  or `sinka.example.com`.

Redacted output is genuinely useful. A scrubbed log is fixable; a leaked
password is your problem to rotate. If something sensitive did slip in, revoke
or rotate it first, then say so here without repeating the value.
