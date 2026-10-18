# AIdentify handoff

## Hosted demo (18 Oct 2026 ~12:50 IST)
- Live: https://aidentify-demo.vercel.app (Vercel Hobby, team aidentify)
- Waitlist: https://aidentify-demo.vercel.app/waitlist (and /early-access)
- Health: /api/health reports db:neon, schema demo
- Branch: hosted-demo (CLI deploy; GitHub not linked to Vercel yet)
- Local box still runs Slack + board worker; Vercel does not
- Waitlist now requires email; one row per person, unique by email AND by WhatsApp (re-submitting with either updates the row). Admin export: GET /api/waitlist?format=csv
- Public sign-up is open (email + password). Google and email-code sign-in are not configured on Vercel (no GOOGLE_CLIENT_ID / SMTP)
- Admin password for hosted: saved on box at /workspace/aaas-run/vercel-admin.secret (chmod 600); not in git

A one-page status for anyone picking up AIdentify: what it does today, what is in progress, and what is known to be
missing. Last updated 18 Oct 2026 (hosted demo + landing live; CHANGELOG 1.7.0 drafted on `hosted-demo`, GitHub Release not cut yet).

| | |
|---|---|
| Live demo | **https://aidentify-demo.vercel.app** (Vercel Hobby, `hosted-demo` branch) |
| Marketing / waitlist | **https://aidentify.vercel.app** (join waitlist; same form as `/waitlist` and `/early-access` on the demo) |
| Signup on demo | Email + password open. Google and email-code sign-in not configured yet |
| Code | github.com/aidendify/AaaS (**private**: you need access to clone or install it) |
| Licence | Proprietary, all rights reserved, from v1.6.0 (see LICENSE). v1.5.0 and earlier were MIT. |

## What it is

AIdentify is a self-hosted app for agencies and small marketing teams. You sign in, describe the business, and it sets
up a **Chief of Staff** assistant with a team of AI agents: lead replies, follow-ups, quote tracking, social posts,
research and a real browser. Anything that sends, posts, publishes, pays or signs in waits for your approval. You can run
it from the web app or from Slack.

## What has shipped

- **v1.1, the first build.**
  - A web workspace with sign-in (password, emailed code or Google).
  - Agents with their own knowledge, the Chief of Staff, and routines (scheduled jobs).
  - Connected apps, email, social posting through Buffer, web search, and agents that use a real browser.
  - Share links for your customers. It runs on a small server or on Vercel.
- **v1.2, the open-source release.**
  - A one-line installer and updater, and Docker support.
  - A Slack bot that only obeys the owner.
  - Group goals and task boards.
  - The "remote browser": open the agents' browser from your phone to sign in to sites.
  - A free lead finder.
  - The project files open-source repos usually have (licence, contribution guide, issue templates, automatic checks).
- **v1.3, the Settings page.**
  - One admin page covers 16 areas: AI models and keys (six providers), cheap and strong models with fallbacks,
    usage and estimated cost with a monthly cap, approvals, Slack, the browser, schedules, connected-app keys with
    Test buttons, memory, notifications, branding, backup and restore, updates, security and logs.
  - Changes apply without a restart. Secrets are stored encrypted.
- **v1.4, security basics.**
  - **Passwords:**
    - There are no default passwords: a new server makes you create the admin password, using a one-time code from the server log.
    - Weak passwords are refused.
    - Old default logins are blocked.
  - **Remote browser:**
    - It now has a hard 60-minute limit and a limit on how often it can be opened.
    - Every open and close is logged.
    - Only the owner can open it.
  - **Docs:** a security guide covering the remote-browser risks, and a checklist for going live.
  - **Tests:** automatic tests for all of the above.
  - **Names:** leftover "AgentSphere" names were replaced.
  - **Read-only analytics:** a social analytics snapshot command (`npm run social:snapshot`).
- **v1.6, licence change.** AIdentify is now proprietary (all rights reserved). Contributions by invitation only, with a
  signed contributor agreement. Copies obtained under MIT while it was public keep their MIT rights for that version.
  Git history was not rewritten, so old commits still carry the MIT LICENSE file.
- **v1.5, hostable storage and a test suite.**
  - Hosted mode (`HOSTED=1` or `NODE_ENV=production`) requires Postgres; a single self-hosted server keeps `data/kv.json`.
  - Neon or any Postgres, with automatic table setup and upgrades, retries, a connection pool, and protection against lost updates.
  - `npm run db:migrate-from-file` and `npm run db:export-to-file` to move data between the file and Postgres.
  - Automated tests for sign-up and login, approvals, agent routing, connectors and both storage types, with stand-ins for AI, Buffer and email.

## Highlights worth promoting

These screenshots were taken from a local test server with made-up data (no real accounts).

1. **One Chief of Staff, a team of agents.** Describe the business once, and lead-reply, follow-up, quote-tracking,
   social, research and browser agents are ready, with an enquiry form link.
   ![Workspace with the Chief of Staff and agents](docs/media/workspace-chief-of-staff.png)
   *The test server had no AI key, so the Chief's reply here is the offline fallback.*
2. **Choose your AI and control the cost.**
   - Use OpenRouter, OpenAI, Anthropic, xAI, Google or a local model.
   - Pick a cheap model for routine work and a strong one for planning, with automatic fallbacks.
   - See the estimated spend, and set a monthly cap.
   ![Settings: models and keys](docs/media/settings-models.png)
3. **Nothing goes out without your OK.** Emails, social posts, app actions, risky browser steps, lead replies and
   publishing each need your approval, or can be blocked completely.
   ![Settings: approvals and safety](docs/media/settings-approvals.png)

## In progress

The launch-readiness list. Step 1 (security basics) shipped in v1.4.0 and step 4 (storage and tests) in v1.5.0.

- **Step 2, hosted demo:** **live** on Vercel Hobby (18 Oct 2026). Demo at https://aidentify-demo.vercel.app; marketing waitlist at https://aidentify.vercel.app. Neon schema `demo`; shared OpenRouter key with in-app $10 soft cap + customer BYOK; Google login hidden until OAuth is configured. Still open on this step: link the GitHub repo to Vercel (CLI deploy only today), and wire Google / email-code sign-in when ready.
- **Step 3, payments (Razorpay):** waiting for Phanindra's inputs. A webhook signature checker (`lib/billing.js`) and its tests exist; no payment route yet.
- More of the launch list after the demo, such as onboarding polish and priced plans (not started).
- Step 1 follow-ups: see "Known issues".

## Known issues and limits

- **Installing needs repo access.** The repository is private.
  - Install with `gh repo clone aidendify/AaaS` (or an SSH or token clone), then `./install.sh`.
  - `npm run update` works from that clone.
  - The old public `curl … | bash` line and raw file links no longer work for anonymous users.
- **Mobile apps.** The Android app ID changed to `com.aidentify.app`, so it installs as a new app. No new Android or
  Windows builds are included: the build tools are not set up on the build machine.
- **Remote browser.** Anyone with its link controls a browser signed in to your accounts until it closes, at most
  60 minutes. The ngrok free plan shows a warning page first. See SECURITY.md.
- **Costs are estimates,** based on OpenRouter's prices. Only usage recorded since v1.3.0 counts.
- **Docker.** The image has no Chrome, so the browser agents and the remote browser are off there.
- **Some Test buttons have never been tried against a real account:** Gumroad, Buffer, Composio, Gmail, OpenAI, Google and Ollama.
- **Social analytics snapshot.** It needs the agents' browser to be signed in to the right X, LinkedIn and Facebook accounts.
  Otherwise it reports "wrong account" or "not signed in" instead of numbers.
- **Storage.** The box's own live server still runs on `data/kv.json` on purpose. The migration tool was tried on a copy of real data against a local Postgres, not against Neon. Rate limits are still kept per server instance.
- **Tests.** The browser "pay" check is tested as a rule (which clicks wait for approval); approving a browser step is not tested because it would start a real browser. The Chief of Staff test covers handing work to an agent; turning a goal into board tasks is done by the group lead, and that is tested too.
- **Automatic checks.** They use the account's GitHub Actions minutes now that the repo is private, so they run once per change, and only for code.
