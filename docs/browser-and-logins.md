# Agents' browser and sign-ins

AaaS agents can use a real Chromium (`lib/browser.js`). By default every session is a fresh headless browser with no cookies. To let agents use sites you are signed in to (Gumroad dashboard, marketplaces, Gmail web), give them **one persistent profile** and sign in to it yourself.

## Set up

1. In `.env`:
   ```
   BROWSER_PROFILE_DIR=data/browser-profile
   BROWSER_HEADLESS=true          # agents work invisibly; false shows their window on DISPLAY / BROWSER_DISPLAY
   ```
2. Sign in once, yourself, in a visible window:
   ```
   npm run browser:login -- https://mail.google.com https://app.gumroad.com/login
   BROWSER_DISPLAY=:1 npm run browser:login -- https://...   # choose the desktop the window opens on
   ```
   Type your passwords there, complete 2-factor, then close the window. The cookies stay in the profile folder.
3. Restart nothing: the next agent browser step uses the saved sign-ins.

## Safety rules

- Passwords are typed only by you, in that window. They never go through chat, Slack, the knowledge base or the server.
- Agents' clicks on "sign in", "buy", "pay", "submit", "delete" and typing into password/OTP fields still stop for your approval.
- One process uses the profile at a time (`<profile>/aidentify.lock`). While your sign-in window is open the agents' browser says "in use"; while an agent is browsing, the sign-in script tells you to wait (the agents' browser closes after 10 idle minutes).
- The profile folder holds live session cookies: it lives under `data/` (git-ignored, mode 700). Delete the folder to sign everything out.
- Prefer an API over the dashboard when one exists (Gumroad: `GUMROAD_ACCESS_TOKEN` gives agents the read-only `gumroad_stats` tool).

## Remote browser (from Slack, phone or laptop)

Open the agents' shared browser from anywhere to sign in to sites, watch the agents or help them.

- In the Slack DM with the bot: `open browser` (or `browser`), `browser status`, `close browser`. A natural DM to the Chief ("open the browser for me") works too: it uses the `remote_browser` tool and the link is posted straight to your DM by the system (the agent never sees it).
- The link is only ever posted in your DM, never in the notifications channel.
- What runs (lib/remote-browser.js): a dedicated Xvfb display (:90 and up, never the box desktop), Google Chrome on the agents' profile with the same plain flags as `npm run browser:login` (Google accepts it), x11vnc on 127.0.0.1 with a random VNC password, websockify + noVNC on 127.0.0.1, a token gate on 127.0.0.1 that serves only `/<128-bit random token>/...` (everything else is 404), and a public tunnel.
- Protection: the link carries the random path token and the VNC password. Neither is logged (the log shows only the first 4 token characters). Pages are sent with `no-store`, `no-referrer` and `noindex`. Anyone with the link can use the browser until it closes, so keep it private.
- Auto-close: after `REMOTE_BROWSER_IDLE_MIN` minutes (default 20) with no input from a viewer, or when a process dies, or on `close browser`, or on server shutdown. Every process is killed by its own PID; the profile lock is released. Auto-closes are announced in your DM.
- While it is open, `<profile>/aidentify.lock` holds the session Chrome's pid, so agent browser steps fail with "in use … close browser" (same as the sign-in window). If an agent is using the browser when you ask, you are told to try again (it frees after 10 idle minutes).
- Tunnel (`REMOTE_BROWSER_TUNNEL`): `auto` (default) uses ngrok when `NGROK_AUTHTOKEN` is set, otherwise a cloudflared quick tunnel. cloudflared needs no account but needs outbound port 7844, which is blocked on the current box, so **set `NGROK_AUTHTOKEN`** (free account at dashboard.ngrok.com, Sign in with Google, copy the authtoken, add it to `.env` through the secure form, restart the server). ngrok free shows a one-time "Visit Site" warning page on first open; tap it once and noVNC loads (the websocket itself is not affected; verified Oct 17, 2026). `none` gives a local-only link (testing).
- Binaries: Xvfb, x11vnc, websockify and noVNC come from apt. cloudflared and ngrok are in /usr/local/bin with copies in /workspace/aaas-run/bin (survives a box reset); override with `CLOUDFLARED_BIN` / `NGROK_BIN`. No new npm packages.

## Email (Gmail)

| Option | Send | Read inbox | What you provide |
|---|---|---|---|
| `GMAIL_USER` + `GMAIL_APP_PASSWORD` in `.env` | yes (SMTP) | no | a Google app password (needs 2-Step Verification) |
| Google OAuth (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) | yes | yes (Gmail connector) | an OAuth client from console.cloud.google.com, authorized redirect URI `http://127.0.0.1:3000/api/connectors/callback` (and `/api/auth/google/callback` for sign-in) |
| Composio (`COMPOSIO_API_KEY`) | yes | yes (`GMAIL_FETCH_EMAILS`) | a Composio API key; you then connect Gmail from the Connectors page |
| Signed-in browser profile | via approval | yes, by reading the web page | sign in with `npm run browser:login` |

## Read-only social analytics snapshot

`npm run social:snapshot` opens the agents' browser profile and reads X, LinkedIn and Facebook analytics and profile pages. It never likes, follows, posts or changes settings. It writes `analytics-YYYY-MM-DD.md` and appends a row to `x-verified-followers.tsv` (source `aidentify-browser`) in `SOCIAL_ANALYTICS_DIR` (default `/workspace/social/analytics`). Screenshots go to `shots/`.

- A site that is signed out, or signed in as a different account, is reported that way and no numbers are guessed. Public profile follower counts are still recorded and labelled.
- If the profile is in use (sign-in window, remote browser or the server's agents), it waits `SOCIAL_RETRY_MIN` minutes (default 4) and tries once more.
- Exit codes: `0` all read, `3` report written but some sites need a sign-in, `2` browser busy, `1` error.
- Accounts can be changed with `SOCIAL_X_USER`, `SOCIAL_FB_USER` and `SOCIAL_LI_NAME`. Options: `--out DIR`, `--date YYYY-MM-DD`, `--no-retry`.

## Remote browser safety limits

- Only the owner can open it: the Slack bot owner (`SLACK_OWNER_USER_ID`), a signed-in admin or owner in Settings (`POST /api/settings/remote-browser`), or the owner's own Chief. There is no public endpoint that starts it.
- It closes after `REMOTE_BROWSER_IDLE_MIN` idle minutes (default 20), and always after `REMOTE_BROWSER_MAX_MIN` minutes (default 60), even while in use. Closing stops Chrome, the VNC server, the token gate and the tunnel, each by its own process id.
- It can be opened at most `REMOTE_BROWSER_OPENS_PER_HOUR` times per hour (default 6).
- Every open, reuse, refusal, failure and close is written to `data/remote-browser-audit.jsonl`, and to the Settings audit log. Links and passwords are never written.
- See [SECURITY.md](../SECURITY.md#remote-browser-risks) for the risks.
