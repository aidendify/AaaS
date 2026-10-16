# Slack bot

AgentSphere can run a Slack bot in **Socket Mode**, so it works from a laptop or a private server with no public URL.

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
6. `SLACK_ACCOUNT_EMAIL`: the AgentSphere account whose agents and boards the bot uses.
7. Restart AgentSphere. The log says `Slack bot: on (Socket Mode)`. DM the bot.

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
  name: AgentSphere
  description: Your AgentSphere agents in Slack
  background_color: "#1d2433"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: AgentSphere
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

- Unprefixed DMs are answered by the orchestrator: `SLACK_AGENT_ID` if set, otherwise the lead of the group that orchestrates other groups (for example "Chief · AIdentify CEO"). If none is set up, the bot says so instead of answering as another agent.
- Top-level DMs are answered in the DM and form one ongoing conversation; a message inside a thread is answered in that thread, which keeps its own history. The last 20 turns per conversation are kept server-side in `as_slack:<email>`.

## Staying connected

Socket Mode reconnects by itself after drops. The bot also logs every socket state change (`Slack socket: …`), writes a heartbeat line every `SLACK_HEARTBEAT_MIN` minutes (default 15) with an `auth.test` check, notes when the process wakes after a long pause, retries startup with backoff (5 s → 5 min), and exits after the socket has been down for `SLACK_WATCHDOG_MIN` minutes (default 5) so a supervisor can restart the server. Run it under a supervisor (systemd, pm2, or a restart loop) for this last step to help.
