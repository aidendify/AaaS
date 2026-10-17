# Changelog

All notable changes to AIdentify are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/aidendify/AaaS/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/aidendify/AaaS/releases/tag/v1.3.0
[1.2.0]: https://github.com/aidendify/AaaS/releases/tag/v1.2.0
[1.1.0]: https://github.com/aidendify/AaaS/commit/b63634d
