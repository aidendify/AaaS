<h1 align="center">AIdentify</h1>

<p align="center"><b>Open-source agent-as-a-service platform.</b><br>
Small businesses and agencies create AI agent workers, connect their tools, and run them from the web or Slack.</p>

<p align="center">
  <a href="https://github.com/aidendify/AaaS/releases/latest"><img src="https://img.shields.io/github/v/release/aidendify/AaaS?style=flat-square" alt="Latest release"></a>
  <a href="https://github.com/aidendify/AaaS/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/aidendify/AaaS/ci.yml?branch=main&style=flat-square&label=ci" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node 20+">
  <a href="https://github.com/aidendify/AaaS/stargazers"><img src="https://img.shields.io/github/stars/aidendify/AaaS?style=flat-square" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
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

**Linux, macOS, WSL2** (needs Node.js 20+ and curl; git is used if present):

```bash
curl -fsSL https://raw.githubusercontent.com/aidendify/AaaS/main/install.sh | bash
```

This installs the latest release into `~/aidentify` (change it with `--dir`), runs `npm install`, and creates `.env`
with a random `SESSION_SECRET`. Then:

```bash
cd ~/aidentify
nano .env            # add OPENROUTER_API_KEY=... (or ANTHROPIC_API_KEY=...), change ADMIN_PASSWORD
npm start            # open http://localhost:3000
```

Options: `bash -s -- --dir /opt/aidentify --version v1.2.0` after `| bash`, or the env vars `AIDENTIFY_DIR` and `AIDENTIFY_VERSION`.

### Manual install

```bash
git clone https://github.com/aidendify/AaaS.git aidentify && cd aidentify
git checkout "$(git describe --tags --abbrev=0)"   # latest release (optional)
npm install
cp .env.example .env                              # add an AI key
npm start
```

**Windows:** install [Node.js 20+](https://nodejs.org), download the [latest release](https://github.com/aidendify/AaaS/releases/latest) zip, unzip it to Desktop or Documents and double-click `start.bat`.

### Docker

```bash
git clone https://github.com/aidendify/AaaS.git aidentify && cd aidentify
cp .env.example .env          # add an AI key and a SESSION_SECRET
docker compose up -d --build  # http://localhost:3000, data kept in the aidentify-data volume
```

Limits: the image does not include Chrome, so the Browser and Research agents' real browser, the owner sign-in window
and the remote browser are off in Docker. Everything else (agents, connectors, Slack, boards, routines) works.

### First run

1. Open http://localhost:3000 and **create an account** (email + password, an emailed sign-in code, or Google if configured).
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

## Requirements

| | |
|---|---|
| Node.js | 20 or newer (required) |
| AI model | an OpenRouter or Anthropic API key (required for agents) |
| Google Chrome or Chromium | optional: Browser/Research agents, sign-in window, remote browser (`npx playwright install chromium` also works) |
| Xvfb, x11vnc, websockify + noVNC | optional: remote browser (`apt install xvfb x11vnc websockify novnc`) |
| ngrok authtoken or cloudflared | optional: public link for the remote browser |

## Configuration

Everything is set in `.env` (copy of [`.env.example`](.env.example), which documents every option). The main ones:

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | OpenRouter key and model (needs tool calling) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Anthropic key and model |
| `AI_PROVIDER` | which provider to try first when several keys are set |
| `SESSION_SECRET` | long random text that signs sessions and encrypts connector credentials |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD`, `TEAM_EMAIL` / `TEAM_PASSWORD` | built-in staff accounts; **change before going live** |
| `DATABASE_URL` | Neon Postgres; empty = `data/kv.json` |
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
| `REMOTE_BROWSER_IDLE_MIN`, `REMOTE_BROWSER_TUNNEL`, `NGROK_AUTHTOKEN` | remote browser timeout and tunnel |
| `CRON_SECRET` | protects `/api/cron/tick` on Vercel |
| `DEMO_MODE`, `RATE_LIMIT` | demo account / sign-in rate limit (leave unset on public servers) |

## Channels and integrations

- **Slack**: create the app from the manifest in [docs/slack.md](docs/slack.md), set the four `SLACK_*` values and restart. DMs go to your orchestrator agent; only the owner is obeyed.
- **Groups and board**: see [docs/groups.md](docs/groups.md). Send a goal from the Groups tab or from Slack with `<group name>: <goal>`.
- **Factory tools**: see [docs/factory-tools.md](docs/factory-tools.md). Give an agent the `sandbox`, `publish` or `ops` tools in its settings.
- **Browser and logins**: see [docs/browser-and-logins.md](docs/browser-and-logins.md). Sign in once with `npm run browser:login`; agents reuse the cookies.
- **Remote browser**: in the Slack DM type `open browser`, `browser status` or `close browser`. The link is private (random token + VNC password) and closes after 20 idle minutes.

## Upgrading

```bash
cd ~/aidentify
npm run update        # same as ./install.sh --update
```

It switches to the newest [release](https://github.com/aidendify/AaaS/releases), reinstalls dependencies and keeps
your `.env` and `data/`. Restart the server afterwards. Pin a version with `./install.sh --update --version v1.2.0`.
What changed is in [CHANGELOG.md](CHANGELOG.md). Watch the repo (**Watch → Custom → Releases**) to be notified.

Docker: `git pull && docker compose up -d --build` (data stays in the volume).

## Documentation

| Doc | |
|---|---|
| [docs/guide.md](docs/guide.md) | full guide: sign-in options, Vercel + Neon deploy, workspace, agents, share links, connectors |
| [docs/slack.md](docs/slack.md) | Slack bot setup, commands, notifications |
| [docs/groups.md](docs/groups.md) | groups, task boards, planning |
| [docs/factory-tools.md](docs/factory-tools.md) | sandbox and publishing tools |
| [docs/browser-and-logins.md](docs/browser-and-logins.md) | agents' browser, sign-in window, remote browser, email options |
| [docs/free-lead-finder.md](docs/free-lead-finder.md) | example lead-finding routine |
| [SECURITY.md](SECURITY.md) | reporting vulnerabilities, hardening |

## Contributing

Contributions are welcome, especially **new connectors**. Read [CONTRIBUTING.md](CONTRIBUTING.md) (it includes a
step-by-step "Build a connector" guide), pick an [issue](https://github.com/aidendify/AaaS/issues) or open a
[connector request](https://github.com/aidendify/AaaS/issues/new?template=connector_request.yml).
Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © AIdentify
