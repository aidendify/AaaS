# Changelog

All notable changes to AIdentify are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.5.0] - 2026-10-18

Storage you can host, and an automated test suite. A self-hosted server with no database keeps working exactly as before.

### Changed (please read)
- **Hosted deploys must use Postgres.** With `HOSTED=1`, `NODE_ENV=production` or on Vercel, the server now refuses to start without `DATABASE_URL` and says why. Your own computer or a single server without `DATABASE_URL` still uses `data/kv.json` and prints a note.

### Added
- **Any Postgres, not only Neon.** Neon addresses use Neon's HTTPS driver; other addresses use a connection pool. Brief network errors are retried.
- **No lost updates.** Account changes merge with the latest saved copy, and workspace saves take a short database lock, so two servers writing at the same moment do not overwrite each other. Before this, two sign-ups at the same moment could lose one account.
- **Automatic database setup and upgrades.** Tables, an index for faster lookups and a record of applied upgrades are created on start. `DATABASE_SCHEMA` keeps them in their own schema.
- **Move data between the file and Postgres.** `npm run db:migrate-from-file` (with `--dry-run`; safe to repeat; checks the count and a hash) and `npm run db:export-to-file`.
- **Automated tests,** run on every push: sign-up and login; approval-first for social posts and email (nothing goes out while pending, reject stops it, approve sends it); the browser's pay/buy/submit steps wait for approval; Chief of Staff hands work to the right agent and a group lead turns a goal into board tasks for the right members; saved connector keys are encrypted and never shown back; both storage types. Outside services (AI, Buffer, email) are stand-ins, so tests cost nothing and send nothing.
- **Billing groundwork.** A checker for Razorpay-style signed webhooks, ready for the payments step. Payments themselves are not built yet; that test is marked as skipped.

## [1.4.0] - 2026-10-18

Security basics before launch. Existing servers keep working with no changes: if you already set `ADMIN_PASSWORD`, nothing changes for you.

### Changed (please read)
- **No more default passwords.**
  - The old built-in logins (`admin1234` and `team1234`) no longer exist.
  - On a new server, the first visit opens a short setup screen where you create your own admin password. You need a one-time code shown in the server log, so a stranger who finds the server first cannot take it over.
  - Instead of the setup screen, you can put a strong `ADMIN_PASSWORD` in `.env` before the first start.
  - Weak or common passwords are refused. Staff passwords need at least 12 characters.
  - **If your server still uses an old default password,** that login is now refused. Put a strong `ADMIN_PASSWORD` (or `TEAM_PASSWORD`) in `.env` and restart: the account takes the new password automatically.
- **The demo account needs its own password.** With `DEMO_MODE=1` you must also set `DEMO_USER_PASSWORD`; there is no default demo password any more.
- **New default staff emails.** If you never set `ADMIN_EMAIL` / `TEAM_EMAIL`, new servers now use `admin@aidentify.local` and `team@aidentify.local`. Existing accounts are not touched.
- **The Android app has a new ID (`com.aidentify.app`).** Android treats it as a different app: people with the old app must install the new one and sign in again, and the old one can be removed. The desktop app ID is now `com.aidentify.desktop`. No new app builds come with this release, because the Android and Windows build tools are not set up on the build machine.
- **Installing needs repository access.** The code repository is now private, so the old `curl … | bash` one-liner no longer works. Clone it with the GitHub CLI or SSH, then run `./install.sh`; `npm run update` keeps working from that clone.

### Added
- **Safer remote browser.** The private link to the agents' signed-in browser:
  - closes after 60 minutes at most, even while in use (`REMOTE_BROWSER_MAX_MIN`);
  - can be opened at most 6 times an hour (`REMOTE_BROWSER_OPENS_PER_HOUR`);
  - records every open and close in an audit log.
  - Only you (the Slack owner, a signed-in admin, or your own Chief) can open it. Another account's agents cannot.
- **Security guide.** SECURITY.md explains the remote-browser risks: anyone with the link controls your signed-in accounts; what the ngrok warning page is; how to cut access off. It also has a hardening checklist for going live.
- **Automatic tests** (`npm test`, run on every change) check that:
  - first-run setup is required;
  - default passwords never work;
  - weak passwords are refused;
  - the remote browser cannot be opened without signing in.
- **HANDOFF.md**: one page on what has shipped, what is in progress and what is known to be missing.
- **`npm run social:snapshot`**: a read-only snapshot of X, LinkedIn and Facebook analytics, taken in the agents' browser.

### Fixed
- Leftover "AgentSphere" names were replaced with AIdentify. Internal names that existing data depends on (a database table name and two hash prefixes) were kept on purpose so nothing breaks.

## [1.3.0] - 2026-10-17: read-only X, LinkedIn and Facebook analytics snapshot in the agents' browser profile. It writes a dated report, a TSV row and screenshots, and reports signed-out or wrong-account sites instead of guessing.

## [1.3.0] - 2026-10-17

### Added
- `/settings` control panel with 16 sections, search and a mobile layout. It is admin-only (or the `SETTINGS_OWNERS` / `SLACK_ACCOUNT_EMAIL` account). Saved values win over `.env`, which wins over defaults, and most changes apply without a restart. Secrets are encrypted at rest (AES-256-GCM) and shown only as their last 4 characters. Changes go to an audit log. See `docs/settings.md`.
- Providers: OpenAI, Google Gemini and Ollama/OpenAI-compatible servers, alongside OpenRouter, Anthropic and xAI.
- Cheap/strong model tiers (`AI_MODEL_CHEAP`, `AI_MODEL_STRONG`) and per-agent tiers. Goal planning uses the strong model.
- Fallback models (`AI_FALLBACKS`), plus temperature, max tokens and timeout settings.
- Usage tracking per day, agent and model. Cost is estimated: OpenRouter's reported charge, or OpenRouter's public prices.
- Monthly spending cap (`block` or `warn`), with alerts at 50/80/100% by Slack DM.
- Test buttons for every provider key, Slack, GitHub, Gumroad, Buffer, Composio, Tavily, Gmail and the browser tools, plus a test prompt.
- OpenRouter model browser with prices.
- Approval switches (`ask`/`block`) for email, social, app actions, risky browser steps, lead replies, GitHub and Gumroad.
- Notification switches, agent memory switch, house rules for agents, `AGENT_MAX_STEPS` and `APP_TIMEZONE`.
- Branding (name, colour, logo).
- Backup download and restore with a dry-run diff and a safety copy.
- Update check against GitHub releases, a staff password change and "sign everyone out".
- Server log view with secrets masked.
- Slack reconnects by itself when its tokens change in Settings.

### Changed
- All model calls go through one routing path (`lib/llm.js`). The old single-call helpers in `lib/backend.js` were removed.

### Earlier unreleased
- README "Use cases" section: six setups for agencies and digital/email marketing teams, each with the features it uses and a "Try it" step.

## [1.2.0] - 2026-10-17

First public open-source release.

### Added
- One-line installer and updater (`install.sh`, `npm run update`) that installs the latest tagged release and keeps `.env` and `data/`.
- Dockerfile and `docker-compose.yml` with a persistent `data/` volume.
- Remote browser: owner-only Slack DM commands `open browser`, `browser status` and `close browser`, plus a Chief `remote_browser` tool. Runs a private Xvfb display with Chrome on the agents' profile, x11vnc and noVNC behind a random token, through an ngrok or cloudflared tunnel, and closes itself after an idle timeout.
- Chief operations tools: list, pause, resume and create schedules; list and cancel board tasks (`/api/board/cancel`). Agents are told never to claim an action they did not complete.
- `SLACK_NOTIFY_CHANNEL` for review cards, failures and briefs.
- Free lead finder: board routines, Slack briefs, per-draft approvals and approved replies sent through the browser.
- Persistent browser profile with an owner sign-in window (`npm run browser:login`) that uses plain Google Chrome; read-only `gumroad_stats`.
- Factory tools: sandboxed project folder and approval-gated GitHub and Gumroad publishing.
- Slack bot in Socket Mode: owner-only DMs routed to the orchestrator agent, per-conversation history, group goals (`desk: ...`), review notifications with Approve and Reject buttons.
- Groups, task boards, a worker loop and paused routines.
- Open-source project files: MIT LICENSE, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, issue and PR templates, CI syntax check (`npm run check`).

### Changed
- Rebranded to AIdentify across the UI, emails, Slack messages, prompts, docs and app names.
- Slack: DMs are answered asynchronously with an instant :eyes: reaction, missed DMs are answered after a reconnect, and a watchdog forces a reconnect about 60 seconds after a pause or dead socket.
- Goal planning always chains two or more tasks; research tasks get 25 steps; longer model timeout.
- README rewritten for installers and contributors; the previous long README is now `docs/guide.md`.

### Fixed
- Literal `\n` in Slack replies; clearer replies for stale approvals.
- Clean shutdown on SIGTERM.

## [1.1.0] - 2026-10-17

### Added
- Initial AIdentify (AaaS) build: web workspace with sign-in (email + password, email code, Google), agents with knowledge bases, Chief of Staff orchestrator, routines, connectors (OAuth, API keys or Composio), Gmail, Buffer social posting, web search, real browser agents, customer share links and live apps, local file or Neon Postgres storage, and Vercel deployment.

[Unreleased]: https://github.com/aidendify/AaaS/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/aidendify/AaaS/releases/tag/v1.4.0
[1.3.0]: https://github.com/aidendify/AaaS/releases/tag/v1.3.0
[1.2.0]: https://github.com/aidendify/AaaS/releases/tag/v1.2.0
[1.1.0]: https://github.com/aidendify/AaaS/commit/b63634d
