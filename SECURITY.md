# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Use GitHub's private
[Report a vulnerability](https://github.com/aidendify/AaaS/security/advisories/new) form, or email
contact.aidentify@gmail.com with "SECURITY" in the subject. Include steps to reproduce and the version (`package.json`).
We aim to reply within 5 working days and will credit you in the release notes unless you prefer otherwise.

## Supported versions

Only the latest release gets security fixes. Update with `npm run update`.

## How AIdentify handles secrets

- Keys live in `.env` (never committed; `.gitignore` excludes it) or, for connectors, encrypted server-side with AES-256-GCM using a key derived from `SESSION_SECRET`. They are never sent to the browser.
- Actions that change things outside the app (sending email, posting, publishing, paying, signing in, submitting forms) wait for the owner's approval.
- Web reads, the agents' browser and live-app addresses refuse private, localhost and metadata hosts.
- The Slack bot obeys only `SLACK_OWNER_USER_ID`. Remote browser links are posted only in the owner's DM and are protected by a random token and VNC password.

## Before exposing a server to the internet

- Set a long random `SESSION_SECRET` (the installer does this) and change `ADMIN_PASSWORD` and `TEAM_PASSWORD`.
- Leave `DEMO_MODE` and `RATE_LIMIT=off` unset.
- Put it behind HTTPS (a reverse proxy such as Caddy or nginx) and set `APP_URL` to the public address.
