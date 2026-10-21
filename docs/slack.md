# Slack bot

AaaS can run a Slack bot in **Socket Mode**, so it works from a laptop or a private server with no public URL.

This page is the one server-wide bot (environment variables, one owner). A business that wants its own Slack app, with a bot token and signing secret saved on the Inbox page, uses the per-account channel in `docs/CHANNELS.md`. That one checks Slack’s request signature and can optionally hand customer messages to the front desk.

What it does:

- Obeys **one owner** (`SLACK_OWNER_USER_ID`). Messages from anyone else are ignored.
- A DM goes to the orchestrator agent: the lead of the group that orchestrates other groups (set "Orchestrates groups" in the Groups tab), or Chief of Staff if there is none.
- `desk: <goal>` or `factory: <goal>` (any group name, then a colon) sends the text as a goal to that group; its lead plans the tasks.
- Replies go in the thread of your message.
- It only posts what needs you: tasks in review that want to send or publish something, finished goals, standalone tasks, and failures. Routine successes stay quiet.
- Review cards have **Approve** and **Reject** buttons (same as approving in the Groups tab).

## Setup

1. Go to <https://api.slack.com/apps> → **Create New App** → **From an app manifest**, pick your workspace and paste the manifest below.
2. **Basic Information → App-Level Tokens → Generate**: add the scope `connections:write`. Copy the `xapp-…` token → `SLACK_APP_TOKEN`.
3. **Install App** → install to the workspace. Copy the **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`.
4. Optional: **Basic Information → Signing Secret** → `SLACK_SIGNING_SECRET` (not needed for Socket Mode).
5. Your member ID: in Slack, click your profile → ⋯ → **Copy member ID** → `SLACK_OWNER_USER_ID`.
6. `SLACK_ACCOUNT_EMAIL`: the AaaS account whose agents and boards the bot uses.
7. Restart AaaS. The log says `Slack bot: on (Socket Mode)`. DM the bot.

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_OWNER_USER_ID=U0123456789
SLACK_ACCOUNT_EMAIL=you@example.com
# optional
SLACK_SIGNING_SECRET=
```

Values in the shell environment win over `.env`. Make sure no old Slack tokens are exported in the shell that starts the server.

## App manifest

```yaml
display_information:
  name: AaaS
  description: Your AaaS agents in Slack
  background_color: "#1d2433"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: AaaS
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - im:history
      - im:read
      - im:write
      - reactions:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - message.im
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

Scopes: `chat:write` (replies and notifications), `im:history` + `message.im` (read your DMs), `im:read` / `im:write` (open the DM for notifications), `reactions:write` (the 👀 "working on it"), `users:read` (optional, names). The app-level token needs `connections:write` for Socket Mode.

Code: `lib/slack.js`, started from `server.js`.

## Who answers and conversation memory

- Unprefixed DMs are answered by the orchestrator: `SLACK_AGENT_ID` if set, otherwise the lead of the group that orchestrates other groups (for example "Chief · AaaS CEO"). If none is set up, the bot says so instead of answering as another agent.
- Top-level DMs are answered in the DM and form one ongoing conversation; a message inside a thread is answered in that thread, which keeps its own history. The last 20 turns per conversation are kept server-side in `as_slack:<email>`.

## Staying connected

Socket Mode reconnects by itself after drops. The bot also logs every socket state change (`Slack socket: …`), writes a heartbeat line every `SLACK_HEARTBEAT_MIN` minutes (default 15) with an `auth.test` check, notes when the process wakes after a long pause, retries startup with backoff (5 s → 5 min), and exits after the socket has been down for `SLACK_WATCHDOG_MIN` minutes (default 5) so a supervisor can restart the server. Run it under a supervisor (systemd, pm2, or a restart loop) for this last step to help.

## Notifications channel

Set `SLACK_NOTIFY_CHANNEL` to a channel id (Slack: open the channel → channel name → About → Channel ID, e.g. `C0123ABCD`) to send review cards, failure notes and scheduled briefs there. Conversation with the Chief stays in the DM. The bot must be a member of the channel: type `/invite @AaaS` in it (private channels too). Leave it empty to keep everything in the DM. Approve / Reject buttons work in the channel, but only for the owner.

## Chief operations tools

The orchestrator agent has the `ops` tools: `list_schedules`, `set_schedule_paused`, `create_schedule` (new schedules start paused), `list_board_tasks` and `cancel_board_task`. Agents are told never to claim an action that no tool result confirms.

## Remote browser commands

Owner DM only: `open browser` / `browser` (link + expiry, in the DM), `browser status`, `close browser`. The Chief also has a `remote_browser` tool (open/close/status) so "open the browser" in plain words works; the link goes to the DM directly and never to `SLACK_NOTIFY_CHANNEL`. No extra Slack scopes are needed. Details: docs/browser-and-logins.md.
