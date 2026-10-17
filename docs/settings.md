# Settings

`/settings` (also linked from the Settings tab in the app) is the server's control panel. It changes the
running server without editing `.env` or restarting.

## Who can open it

Accounts with the `admin` role, or an email listed in `SETTINGS_OWNERS` (comma separated). If
`SETTINGS_OWNERS` is not set, the `SLACK_ACCOUNT_EMAIL` account can open it too. Everyone else gets 403.

## How values are chosen

**Saved in Settings > `.env` > built-in default.** Each field shows a badge saying where its current value
comes from (`set here`, `from .env`, `default`). Clearing a field brings back the `.env` value. Your
existing `.env` keeps working with no changes.

Settings are stored in the `as_settings` key of the database (`data/kv.json` or Postgres). Secret values
(API keys, tokens, passwords) are encrypted with AES-256-GCM, using a key derived from `SESSION_SECRET`.
They are never sent back to the browser. The page shows only the last 4 characters. Changing
`SESSION_SECRET` makes the saved secrets unreadable, so save them again after a change.

These stay in `.env` only: `PORT`, `HOST`, `DATABASE_URL`, `SESSION_SECRET`, `DEMO_MODE`, `ADMIN_EMAIL`.

Most changes apply at once. A few fields that are read only at start-up say "restart needed" after you save.
Changing a Slack token reconnects the Slack bot by itself.

## Sections

| Section | What you can do |
|---|---|
| Models & keys | Keys and models for OpenRouter, Anthropic, OpenAI, xAI, Google Gemini and any Ollama/OpenAI-compatible server. Set the provider to try first, a cheap and a strong model, a fallback list (`provider:model`, one per line), temperature, max tokens and timeout. Browse OpenRouter models with their prices. Test each key, and send a tiny test prompt. |
| Usage & spending | Calls, tokens and **estimated** cost per day, agent and model. Set a monthly cap and what happens when it is reached (`block` or `warn`). You are alerted at 50%, 80% and 100% (Slack DM, if the bot is on). |
| Agents | Per-agent model and cheap/strong tier, max steps per run, default tier, and house rules added to every agent's instructions. |
| Approvals & safety | For email, social posts, app actions, risky browser steps, lead replies, GitHub and Gumroad publishing: `ask` (needs your approval, the default) or `block` (agents cannot do it). |
| Messaging (Slack) | Bot and app tokens, owner, notify channel, heartbeat and watchdog. Test the token or send yourself a test DM. |
| Browser | Agents' browser profile and display, remote browser timeout and tunnel, ngrok token. Open, close and check the remote browser. |
| Schedules & board | Timezone. List routines and pause or resume one or all of them. |
| Connectors & tools | GitHub, Gumroad, Buffer, Composio, Tavily and Gmail keys, plus your own OAuth apps. Test buttons for each. |
| Memory & knowledge | Turn agent memory on or off. View and delete what agents remembered. |
| Notifications | Turn Slack notifications on or off for reviews, failures, briefs and spending alerts. |
| Workspace & brand | Product name, accent colour, logo, public URL. |
| Data & backup | Download a JSON backup of the whole database. Restore one, with a dry-run diff first; a safety copy is written to `data/backups/` before anything is replaced. |
| Updates | Your version compared with the latest GitHub release (or `main`), and the update command. |
| Security | Change the staff password (12+ characters), sign everyone out, sign-in rate limit, and the audit log of settings changes. |
| Logs & diagnostics | Recent server log lines with secrets masked, plus a status overview. |
| About | Version, licence, links. |

## Costs are estimates

If OpenRouter reports what a call cost, that number is used. Otherwise the cost is worked out from
OpenRouter's public price list (`/api/v1/models`). Models it does not list are counted as "unknown cost".
Usage is recorded from v1.3.0 on, and the cap only counts calls recorded since then. Check your provider's
own billing page for exact charges.

## Backups contain secrets

A backup holds everything in the database: password hashes, encrypted settings and connector credentials.
Keep the file private.
