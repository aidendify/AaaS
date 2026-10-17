<h1 align="center">AIdentify</h1>

<p align="center"><b>Self-hosted agent-as-a-service platform. Proprietary: all rights reserved.</b><br>
Small businesses and agencies create AI agent workers, connect their tools, and run them from the web or Slack.</p>

<p align="center">
  <img src="https://img.shields.io/badge/release-v1.6.0-6d5efc?style=flat-square" alt="Release v1.6.0">
  <a href="https://github.com/aidendify/AaaS/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/aidendify/AaaS/ci.yml?branch=main&style=flat-square&label=ci" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-proprietary-lightgrey?style=flat-square" alt="Proprietary licence"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node 20+">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#use-cases">Use cases</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#upgrading">Upgrading</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

AIdentify is a self-hosted Node.js app. You sign in, tell it what kind of business you run, and it sets up a
**Chief of Staff** orchestrator with matching agents (lead forms, follow-ups, research, social posting, a CRM and
more). Agents use real tools: your connected apps, web search, a real browser, email and social posting. Anything that
sends, posts, publishes, pays or signs in **waits for your approval**.

## Quick start

> **The repository is private.** Installing needs access to `aidendify/AaaS` and a signed-in git: the
> [GitHub CLI](https://cli.github.com) (`gh auth login`), an SSH key, or a token. Anonymous `curl … | bash` installs
> and raw file links do not work.

**Linux, macOS, WSL2** (needs Node.js 20+ and git):

```bash
gh repo clone aidendify/AaaS aidentify   # or: git clone git@github.com:aidendify/AaaS.git aidentify
cd aidentify
./install.sh                             # checks out the latest release, runs npm install, creates .env
nano .env                                # add OPENROUTER_API_KEY=... (or ANTHROPIC_API_KEY=...)
npm start                                # then open http://localhost:3000/setup
```

`install.sh` creates `.env` with a random `SESSION_SECRET`. It never overwrites an existing `.env` or `data/`.
Pin a release with `--version v1.4.0` (or `AIDENTIFY_VERSION`).

**First start: create the admin.** There is no default admin password. Open `/setup` and enter the one-time setup code
printed in the server log, an admin email and a strong password (12+ characters, not a common one). Or set a strong
`ADMIN_PASSWORD` in `.env` before the first start. Until one of these is done, nobody can sign in as admin.

### Manual install

```bash
gh repo clone aidendify/AaaS aidentify && cd aidentify
git checkout "$(git describe --tags --abbrev=0)"   # latest release (optional)
npm install
cp .env.example .env                              # add an AI key
npm start                                         # open http://localhost:3000/setup
```

**Windows:** install [Node.js 20+](https://nodejs.org). Download the latest release zip from the
[Releases page](https://github.com/aidendify/AaaS/releases) while signed in to GitHub with access to the repo, unzip it
and double-click `start.bat`.

### Docker

```bash
gh repo clone aidendify/AaaS aidentify && cd aidentify
cp .env.example .env          # add an AI key, a SESSION_SECRET and a strong ADMIN_PASSWORD (or use /setup)
docker compose up -d --build  # http://localhost:3000, data kept in the aidentify-data volume
```

Limits: the image does not include Chrome, so the Browser and Research agents' real browser, the owner sign-in window
and the remote browser are off in Docker. Everything else (agents, connectors, Slack, boards, routines) works.

### First run

1. Create the admin at `/setup` (see above). Then open http://localhost:3000 and **create an account** (email + password, an emailed sign-in code, or Google if configured).
2. Onboarding asks what kind of business you run (clinic, real estate, shop, coaching, digital marketing agency or other) and adds a matching agent pack and a lead form.
3. Chat with **Chief of Staff**, the first tile in My Workplace. It delegates to your agents, creates new agents from a description and teaches them.
4. Add agents from **Plugins → Agents** and apps from **Plugins → Connectors**.

## Features

- **Agent workers** with their own knowledge base, memory, routines (scheduled work) and app screens; build new ones from a description or a pasted spec.
- **Chief of Staff orchestrator** that plans, delegates to agents in parallel and creates or teaches agents.
- **Approvals** for every outside action: emails, social posts, replies to leads, browser clicks on pay/submit/sign in, publishing.
- **Connectors**: OAuth sign-in for Google (Gmail, Calendar, Drive, Sheets), Microsoft 365/Outlook/Teams, GitHub, Slack, Notion, HubSpot, Salesforce, Jira, Confluence, Linear, Asana, Shopify, Zendesk, Xero, QuickBooks and more; API-key connectors such as Stripe, Trello, Twilio and Vercel; or one `COMPOSIO_API_KEY` for managed sign-in. Credentials are encrypted server-side.
- **Email and social**: Gmail send/read (app password or OAuth) and posting to X, LinkedIn, Facebook, Instagram, Threads and more through Buffer.
- **Web search and page reading** with no key (DuckDuckGo; Tavily optional), plus file attachments in chat.
- **Real browser** for the Browser and Research agents (Playwright + Chrome), with a persistent profile you sign in to yourself.
- **Groups and task boards**: teams of agents with a lead, goals split into tasks, a worker loop, review and approval.
- **Slack bot** (Socket Mode, no public URL): DM the Chief, send goals to a group (`desk: find 5 leads`), approve or reject from cards.
- **Factory tools**: a sandboxed project folder per agent and approval-gated publishing to GitHub and Gumroad.
- **Remote browser**: say `open browser` in Slack to get a private link to the agents' browser from your phone or laptop.
- **Customer share links** (`/p/…`): lead forms, qualify pages, quotes and more, served by the same server.
- **Storage** in a local file (`data/kv.json`) or Neon Postgres; deployable to a VPS, Docker or Vercel (serverless, without the browser).

## Use cases

Six setups agencies and digital/email marketing teams can try today. Each uses only features in this repo; anything
that sends, posts or publishes waits for your Approve.

### 1. Answer every enquiry and follow up automatically
New website enquiries get a reply and two qualifying questions right away, then a polite Day 0 / 3 / 7 follow-up sequence.
**Uses:** onboarding agent pack, FormFirst (customer lead form link), Nudge, Gmail connector, approvals, knowledge base.
**Try it:** at onboarding pick *Digital marketing agency*, open **FormFirst Agent** and share its lead-form link (`/p/…`); teach it your services with *"add to FormFirst's knowledge: our SEO audit is a one-week project"*.

### 2. Find automation leads without paid bidding
Agents read fresh public job posts from the n8n and Make communities and Hacker News, qualify them and draft one reply per lead for you to approve.
**Uses:** `lead_feeds` tool, `propose_reply`, Slack approval cards (one per draft), the agents' browser to post approved replies ([example routine](docs/free-lead-finder.md)).
**Try it:** Slack DM to the bot: *"Use lead_feeds for the last 7 days, pick the 3 best n8n or Make requests and propose a reply for each."*

### 3. Run a freelance pipeline as an agent team
A group of agents scouts requests, qualifies them, drafts proposals and keeps client follow-ups moving on a task board, with you approving each step.
**Uses:** Groups and task board (lead agent plans 2+ chained tasks), worker loop, review + Approve / Reject, Slack goals.
**Try it:** in **Groups**, create a group named *Desk* with a lead (e.g. Research Agent) and members, then DM the bot: *"desk: find 5 fresh requests for email marketing help and draft a short proposal for each."*

### 4. Keep a client's social calendar filled
An agent drafts posts on a schedule and publishes them to the client's connected accounts through Buffer after you approve them.
**Uses:** Social agent, Buffer connector, routines (schedules), Chief of Staff, approvals.
**Try it:** connect Buffer in **Plugins → Connectors**, then ask Chief of Staff: *"Every Monday at 9:30 draft three LinkedIn posts about email deliverability for my approval."*

### 5. Build and list a small digital product
A Factory agent writes a template or tool in its sandboxed project folder, then proposes a GitHub repo and an unpublished Gumroad draft; nothing goes live without your approval.
**Uses:** Factory tools (`sandbox`, `publish`), board review, approval-gated GitHub and Gumroad publishing ([docs](docs/factory-tools.md)).
**Try it:** in the Groups tab's agents table give an agent the `sandbox` and `publish` tools, set `GITHUB_TOKEN` / `GUMROAD_ACCESS_TOKEN`, and send it a goal such as *"build a cold-email subject line checklist as a Markdown pack and prepare a Gumroad draft"*.

### 6. Sign agents in to client dashboards from your phone
Open the agents' real browser from Slack, sign in to a client tool yourself, close it, and the Browser and Research agents reuse that sign-in.
**Uses:** remote browser (owner-only Slack commands), persistent browser profile, Browser agent ([docs](docs/browser-and-logins.md)).
**Try it:** DM the bot *"open browser"*, sign in through the private link, then *"close browser"* and ask the Browser Agent to read the page you need.

## Requirements

| | |
|---|---|
| Node.js | 20 or newer (required) |
| AI model | an OpenRouter or Anthropic API key (required for agents) |
| Google Chrome or Chromium | optional: Browser/Research agents, sign-in window, remote browser (`npx playwright install chromium` also works) |
| Xvfb, x11vnc, websockify + noVNC | optional: remote browser (`apt install xvfb x11vnc websockify novnc`) |
| ngrok authtoken or cloudflared | optional: public link for the remote browser |

## Settings

Open **`/settings`** (or the Settings tab → *Open Settings*) as an admin, or as the `SETTINGS_OWNERS` / `SLACK_ACCOUNT_EMAIL` account. It has 16 sections covering:

- AI providers: OpenRouter, Anthropic, OpenAI, xAI, Google Gemini, Ollama/OpenAI-compatible.
- Cheap/strong models, fallbacks, and usage with **estimated** cost and a monthly cap.
- Per-agent models, approvals (`ask`/`block`), Slack, browser and remote browser.
- Schedules, connector keys with Test buttons, memory, notifications and branding.
- Backup/restore, updates, security with an audit log, and logs.

Saved values win over `.env`, which wins over defaults. Most changes apply live. Secrets are encrypted at rest and only their last 4 characters are shown. Your `.env` keeps working unchanged. See [docs/settings.md](docs/settings.md).

## Configuration

Everything can be set in `.env` (copy of [`.env.example`](.env.example), which documents every option). The main ones:

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | OpenRouter key and model (needs tool calling) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Anthropic key and model |
| `AI_PROVIDER` | which provider to try first when several keys are set |
| `OPENAI_API_KEY`, `XAI_API_KEY`, `GOOGLE_AI_API_KEY`, `OLLAMA_BASE_URL` | more providers (each with `_MODEL` and `_BASE_URL`) |
| `AI_MODEL_CHEAP`, `AI_MODEL_STRONG`, `AI_FALLBACKS` | model routing and fallbacks |
| `SPEND_CAP_MONTH_USD`, `SPEND_CAP_ACTION` | monthly cap on estimated spend (`block` or `warn`) |
| `SETTINGS_OWNERS` | extra emails allowed to open `/settings` |
| `SESSION_SECRET` | long random text that signs sessions and encrypts connector credentials |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD`, `TEAM_EMAIL` / `TEAM_PASSWORD` | optional staff accounts. There are no default passwords: a strong one (12+ characters) is required, or create the admin at `/setup` |
| `DATABASE_URL` | Neon or other Postgres; empty = `data/kv.json` (see Storage) |
| `HOSTED` | `1` for a hosted deploy: Postgres becomes required |
| `PORT`, `HOST`, `APP_URL` | listen address (`HOST=0.0.0.0` on a VPS) and the public URL for OAuth callbacks |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | server-wide Gmail for sign-in codes and follow-ups |
| `TAVILY_API_KEY`, `WEB_SEARCH` | better web search, or `off` |
| `BUFFER_API_KEY` | social posting through Buffer |
| `COMPOSIO_API_KEY` | managed sign-in for many connectors |
| `<PROVIDER>_CLIENT_ID` / `_SECRET` | your own OAuth app per provider (Google, Microsoft, GitHub, Slack, Notion, …) |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_OWNER_USER_ID`, `SLACK_ACCOUNT_EMAIL` | Slack bot (all four required) |
| `SLACK_NOTIFY_CHANNEL` | channel for review cards, failures and briefs |
| `GITHUB_TOKEN`, `GITHUB_OWNER`, `GUMROAD_ACCESS_TOKEN` | Factory publishing (approval-gated) |
| `BROWSER_PROFILE_DIR`, `BROWSER_HEADLESS` | agents' persistent browser profile |
| `REMOTE_BROWSER_IDLE_MIN`, `REMOTE_BROWSER_MAX_MIN`, `REMOTE_BROWSER_OPENS_PER_HOUR`, `REMOTE_BROWSER_TUNNEL`, `NGROK_AUTHTOKEN` | remote browser idle timeout, hard session limit, open rate limit and tunnel |
| `CRON_SECRET` | protects `/api/cron/tick` on Vercel |
| `DEMO_MODE`, `RATE_LIMIT` | demo account / sign-in rate limit (leave unset on public servers) |


## Storage

| Where you run it | Storage | What to set |
|---|---|---|
| Your own computer or one server | `data/kv.json` (a file) | nothing. The server prints a note that this is the file store. |
| Hosted (several instances, Vercel, a managed deploy) | Postgres: Neon or any Postgres | `DATABASE_URL` and `HOSTED=1` (or `NODE_ENV=production`) |

- In hosted mode the server **refuses to start without `DATABASE_URL`**, so data can never end up split across instances' local files. `ALLOW_FILE_STORE=1` overrides this for a single-server test.
- Neon URLs (`*.neon.tech`) use Neon's HTTPS driver; other URLs use a `pg` connection pool (`DB_POOL_MAX`, default 10). Brief network errors are retried.
- Tables are created and upgraded automatically (table `agentsphere_kv`, plus `agentsphere_locks` and `agentsphere_migrations`). `DATABASE_SCHEMA` puts them in their own schema.
- Writes that can collide (accounts, one workspace) use a version check or a short database lock, so two servers saving at the same moment do not overwrite each other.
- **Move from the file to Postgres:** `npm run db:migrate-from-file -- --dry-run` shows the plan; run it again without `--dry-run` to copy. It is safe to repeat (identical rows are skipped, rows newer in the database are kept unless `--overwrite`) and it checks the row count and a hash at the end.
- **Back to a file:** `npm run db:export-to-file -- --out data/kv-export.json`.

## Channels and integrations

- **Slack**: create the app from the manifest in [docs/slack.md](docs/slack.md), set the four `SLACK_*` values and restart. DMs go to your orchestrator agent; only the owner is obeyed.
- **Groups and board**: see [docs/groups.md](docs/groups.md). Send a goal from the Groups tab or from Slack with `<group name>: <goal>`.
- **Factory tools**: see [docs/factory-tools.md](docs/factory-tools.md). Give an agent the `sandbox`, `publish` or `ops` tools in its settings.
- **Browser and logins**: see [docs/browser-and-logins.md](docs/browser-and-logins.md). Sign in once with `npm run browser:login`; agents reuse the cookies.
- **Remote browser**: in the Slack DM type `open browser`, `browser status` or `close browser`. The link is private (random token + VNC password) and closes after 20 idle minutes.

## Upgrading

```bash
cd aidentify
npm run update        # same as ./install.sh --update
```

It uses your existing git sign-in (the repo is private), so run it from a clone made with `gh repo clone` or SSH. It switches to the newest [release](https://github.com/aidendify/AaaS/releases), reinstalls dependencies and keeps
your `.env` and `data/`. Restart the server afterwards. Pin a version with `./install.sh --update --version v1.2.0`.
What changed is in [CHANGELOG.md](CHANGELOG.md). Watch the repo (**Watch → Custom → Releases**) to be notified.

Docker: `git pull && docker compose up -d --build` (data stays in the volume).

## Documentation

| Doc | |
|---|---|
| [Use cases](#use-cases) | six setups to try first, with a "Try it" step each |
| [docs/guide.md](docs/guide.md) | full guide: sign-in options, Vercel + Neon deploy, workspace, agents, share links, connectors |
| [HANDOFF.md](HANDOFF.md) | what has shipped, what is in progress, known issues |
| [docs/settings.md](docs/settings.md) | the `/settings` page: sections, precedence, encryption, cost estimates |
| [docs/slack.md](docs/slack.md) | Slack bot setup, commands, notifications |
| [docs/groups.md](docs/groups.md) | groups, task boards, planning |
| [docs/factory-tools.md](docs/factory-tools.md) | sandbox and publishing tools |
| [docs/browser-and-logins.md](docs/browser-and-logins.md) | agents' browser, sign-in window, remote browser, email options |
| [docs/free-lead-finder.md](docs/free-lead-finder.md) | example lead-finding routine |
| [SECURITY.md](SECURITY.md) | reporting vulnerabilities, hardening |

## Contributing

Contributions are by invitation only. If you have been invited, read [CONTRIBUTING.md](CONTRIBUTING.md) (it includes a
step-by-step "Build a connector" guide) and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Copyright (c) 2026 Phanindra Malladi / AIdentify. All rights reserved. See [LICENSE](LICENSE).
No use, copying, modification or distribution without written permission.

Versions before v1.6.0 were published under the MIT License; copies obtained under MIT keep those rights for that version.
