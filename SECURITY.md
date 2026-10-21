# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Use GitHub's private
[Report a vulnerability](https://github.com/aidendify/AaaS/security/advisories/new) form, or email
contact.aidentify@gmail.com with "SECURITY" in the subject. Include steps to reproduce and the version (`package.json`).
We aim to reply within 5 working days and will credit you in the release notes unless you prefer otherwise.

## Supported versions

Only the latest release gets security fixes. Update with `npm run update`.

## How AaaS handles secrets

- Keys live in `.env` (never committed; `.gitignore` excludes it) or, for connectors, encrypted server-side with AES-256-GCM using a key derived from `SESSION_SECRET`. They are never sent to the browser.
- Actions that change things outside the app (sending email, posting, publishing, paying, signing in, submitting forms) wait for the owner's approval.
- Web reads, the agents' browser and live-app addresses refuse private, localhost and metadata hosts.
- The Slack bot obeys only `SLACK_OWNER_USER_ID`. Remote browser links are posted only in the owner's DM and are protected by a random token and VNC password.
- There are no default passwords. A new server has no admin until one is created at `/setup` (with a one-time code from the server log) or from a strong `ADMIN_PASSWORD`. Staff passwords need 12+ characters and cannot be a common password.

## Remote browser risks

The remote browser (Slack "open browser", Settings → Browser, or the owner's Chief) puts the agents' Chrome profile on
a public link. That profile is signed in to your accounts.

- **Anyone with the link controls a browser signed in to your accounts.** They can read mail, post, buy or change
  passwords as you, for as long as the session is open. The link holds a random 128-bit path token and a VNC password.
  Both are in the URL, so the URL alone is enough.
- **Never share, forward or paste the link** (chats, tickets, screenshots, AI tools). It is sent only to the owner's
  Slack DM and is never logged. Slack message previews and synced devices can still show it, so treat your Slack
  account as part of the risk.
- **The ngrok free plan shows an interstitial page** ("You are about to visit…") before the browser loads. That page
  is ngrok's, not a phishing page. It does not protect the session: anyone with the link can click through.
  cloudflared quick tunnels have no such page.
- **Off unless you turn it on.** Set `REMOTE_BROWSER=on` in `.env` on a self-hosted server. On the hosted version (Vercel) it is always off, whatever the setting, and the Chief's `remote_browser` tool is not offered.
- **Per-account scoping.** Only the server owner (`SETTINGS_OWNERS`, default `SLACK_ACCOUNT_EMAIL`) or an admin can open it. The agents' signed-in browser profile (`BROWSER_PROFILE_DIR`) is used only for the owner's own agents. Every other account's agents get a fresh, empty browser with no cookies.
- **Limits that are on by default:**
  - It can only be opened by the owner or an admin. There is no unauthenticated endpoint.
  - It closes after `REMOTE_BROWSER_IDLE_MIN` idle minutes (default 20), and always after `REMOTE_BROWSER_MAX_MIN` (default 60).
  - It can be opened at most `REMOTE_BROWSER_OPENS_PER_HOUR` times per hour (default 6).
  - Every open and close is recorded in `data/remote-browser-audit.jsonl` and the Settings audit log.
- **How to revoke a link:**
  1. Say "close browser" in Slack, or press Close in Settings → Browser. This stops Chrome, the VNC server and the
     tunnel, so the old link stops working at once, and a new open makes a new token.
  2. If you think a link leaked while it was open, sign out of the important sites' other sessions. Most sites offer
     "sign out of all devices" or a security page. Then change those passwords.
  3. Optionally use Settings → Security → Sign everyone out for AaaS sessions.
- The agents' own browser steps that send, post, pay, submit or sign in always wait for your approval (Settings →
  Approvals can block them entirely). The remote browser is you driving by hand, so no approval applies there.

## Deployment hardening checklist

- [ ] Create the admin at `/setup` (or set a strong `ADMIN_PASSWORD`). Never reuse a password from another site.
- [ ] Long random `SESSION_SECRET` (the installer makes one). Keep `.env` mode 600 and out of git.
- [ ] HTTPS in front (Caddy or nginx) and `APP_URL` set to the public https address. Keep `HOST=127.0.0.1` when a
      proxy runs on the same machine.
- [ ] Leave `DEMO_MODE` and `RATE_LIMIT=off` unset.
- [ ] Set `SETTINGS_OWNERS` to your own email only. Review Settings → Approvals (keep `ask` or `block`).
- [ ] Remote browser: keep the default limits. Use your own ngrok account token. Close it when you are done.
- [ ] Firewall: only 80/443 (and SSH) open. The app port, VNC and websockify listen on localhost only.
- [ ] Back up `data/` (Settings → Data & backup). The backup holds password hashes and encrypted keys, so store it privately.
- [ ] Keep up to date with `npm run update`, and watch the repo's releases.
- [ ] Rotate API keys and Slack tokens if a server or backup is ever exposed.

## Before exposing a server to the internet

- Set a long random `SESSION_SECRET` (the installer does this) and create the admin at `/setup` (no default passwords exist).
- Leave `DEMO_MODE` and `RATE_LIMIT=off` unset.
- Put it behind HTTPS (a reverse proxy such as Caddy or nginx) and set `APP_URL` to the public address.


## Tenant isolation

- Each customer's data lives in rows keyed by their email (`as_data:`, `as_rt:`, `as_mem:`, `as_appr:`, `as_act:`, `as_run:`, and so on). Every route uses the signed-in account's email from the session token, never an email from the request.
- Server-only rows (tokens, memories, routines, approvals, activity, settings, usage) are never returned by `/api/kv` to customers, and customers cannot write them.
- Deleting an account removes all its per-account rows.
- `test/tenant-isolation.test.mjs` signs in as two customers and checks every customer route both ways.
