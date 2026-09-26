# Security policy

Sinka is a small self-hosted mail replicator. It talks to your mail provider
with credentials you supply, which makes careful handling of those credentials
the most important thing on this page.

## Supported versions

Sinka is developed and released straight from `main`. There are no numbered
release branches and no long-term support branches, so a fix lands in the
default branch and you pull it.

| Version        | Supported                  |
| -------------- | -------------------------- |
| `main`         | Yes                        |
| Anything else  | No — update to `main`      |

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. A public issue
notifies everyone who watches the repository, including people who would try it.

Instead, email the maintainer privately at `<maintainer email>` — replace that
placeholder with the maintainer's real address if you are sending the report to
them directly. Include:

- what the problem is, and where in the code you believe it lives;
- how to reproduce it, ideally with a harmless example;
- the impact you think it has;
- your suggested fix, if you have one.

You will normally get an acknowledgement within a few days. Reports are
triaged in the order they arrive, fixes land on `main`, and credit is given if
you want it. There are no formal bug-bounty terms here; this project is
maintained as a side project.

## What not to include in a report

Please keep the following out of the report, the issue tracker and the commit
history:

- any token, API key or `*_TOKEN` value;
- Gmail App Passwords, in whole or in part;
- the contents of a real `.env` — key *names* are fine, values are not;
- real email addresses, hostnames, account IDs, database IDs or IP addresses.

Use placeholders instead: `you@example.com`, `team@example.com`,
`sinka.example.com`, `REPLACE_ME_TOKEN`. If a value is genuinely needed to
reproduce a bug, describe where it would be read from and leave the value out.

## If a secret was exposed

If a token, App Password or `.env` value ever ends up in a public issue, a
commit or a log, treat it as compromised:

1. Revoke or rotate it immediately — a Gmail App Password, or the matching
   Cloudflare API token, without waiting for a reply here.
2. Update your own local `.env` (and the Worker secrets on the edge) with the
   new value.
3. Say so in a short, redacted note, so the maintainer knows to check for
   copies in history.

Rotating first and telling someone afterwards is the right order of operations.
Reports are handled quietly and without blame.
