# Agents' browser and sign-ins

AIdentify agents can use a real Chromium (`lib/browser.js`). By default every session is a fresh headless browser with no cookies. To let agents use sites you are signed in to (Gumroad dashboard, marketplaces, Gmail web), give them **one persistent profile** and sign in to it yourself.

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
- One process uses the profile at a time (`<profile>/agentsphere.lock`). While your sign-in window is open the agents' browser says "in use"; while an agent is browsing, the sign-in script tells you to wait (the agents' browser closes after 10 idle minutes).
- The profile folder holds live session cookies: it lives under `data/` (git-ignored, mode 700). Delete the folder to sign everything out.
- Prefer an API over the dashboard when one exists (Gumroad: `GUMROAD_ACCESS_TOKEN` gives agents the read-only `gumroad_stats` tool).

## Email (Gmail)

| Option | Send | Read inbox | What you provide |
|---|---|---|---|
| `GMAIL_USER` + `GMAIL_APP_PASSWORD` in `.env` | yes (SMTP) | no | a Google app password (needs 2-Step Verification) |
| Google OAuth (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) | yes | yes (Gmail connector) | an OAuth client from console.cloud.google.com, authorized redirect URI `http://127.0.0.1:3000/api/connectors/callback` (and `/api/auth/google/callback` for sign-in) |
| Composio (`COMPOSIO_API_KEY`) | yes | yes (`GMAIL_FETCH_EMAILS`) | a Composio API key; you then connect Gmail from the Connectors page |
| Signed-in browser profile | via approval | yes, by reading the web page | sign in with `npm run browser:login` |
