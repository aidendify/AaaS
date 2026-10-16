# AgentSphere

## For the team (this build)

This is the product to deploy and test. Phone and Windows are windows onto **one hosted site**. Do not ask a customer to deploy FormFirst, AfterJob, Nudge, OpenPing, PartPing, or ChangeSlip. Those workflows stay on the agents screen. Each one can share a customer link (`/p/…`). The only “start here” experience is Chief of Staff: the first sign-in asks what the business is (clinic, real estate, shop, coaching, agency, or other), then adds the matching agents and a lead form.

- **Data** stays on the server (`data/kv.json`, or Neon when `DATABASE_URL` is set). Old data folders still open. The phone and the PC see the same leads and approvals. Do not keep a separate copy only on the customer’s PC.
- **Payments are hidden.** Accepting a quote tells the team to start. Collect money outside the app until Stripe or Razorpay is confirmed on the server.
- **Demo account** exists only when `DEMO_MODE=1`. The password is the one in `.env`. The server does not print it. Leave `DEMO_MODE` unset in production. Change `ADMIN_PASSWORD` before the site is public (the default is warned about, not printed).
- **Browser.** Research Agent and Browser Agent can open public sites in a real Chromium. Paying, buying, submitting, or typing a password waits for Approve. This needs Playwright on a VPS or a PC (`npx playwright install chromium`). It will not run on Vercel serverless. Set `BROWSER_EXECUTABLE` if Chromium is installed somewhere else.
- **Safety already in this build:** `/api/ai` needs a signed-in user. Signing out or changing a password ends old sessions. Public form answers are saved on the server even if the owner’s tab is closed. A second device cannot silently overwrite the workspace. Page reads, the agent browser, and live-app addresses refuse private and metadata hosts. The demo FormFirst key is not sent to the browser.
- **Windows and Android are not in this package.** This folder is the hosted web app only. Phone and desktop, when you build them, are just windows onto this same site.
- **First customers (India):** clinic/dentist, real estate, e-commerce, coaching, and digital marketing agencies (and their clients). Onboarding picks the agent pack for that kind of business.

## Quick start (local, 3 commands)

Needs [Node.js 20+](https://nodejs.org/).

```bash
npm install
cp .env.example .env        # Windows: copy .env.example .env  → paste OPENROUTER_API_KEY or ANTHROPIC_API_KEY
npm start
```

**Windows:** unzip, then double-click `start.bat` (installs, creates `.env`, opens the browser). **Mac/Linux:** `./start.sh`.

Open http://localhost:3000 and create an account. A demo sign-in is created only if you set `DEMO_MODE=1` in `.env` (email and password are the `DEMO_USER_*` lines; they are not printed). Admin: the email and password in `.env` (change the default before the site is public).

Everything runs inside this one app: FormFirst, AfterJob, Nudge, OpenPing, PartPing, ChangeSlip, CRM and any agent you build. Their customer links (lead form, qualify page, rating page, quote view, part status, change slip) are served by this server at `http://localhost:3000/p/…`, and customer answers come back into the agent within ~20 seconds.

- **AI models:** OpenRouter (default model `anthropic/claude-sonnet-4.5`), or Anthropic. Set several keys and `AI_PROVIDER` picks the first; the others are fallbacks. If a model can't use tools, agents still answer (without tools) instead of failing.
- **Web search + attachments:** agents search the web and read pages on their own (no key; `TAVILY_API_KEY` for better results). In chat, **+ → Attach files** (or drag-drop) .txt/.md/.csv/.json/.pdf and ask about them.
- **Gmail:** Plugins → Connectors → Gmail → Gmail address + app password. Agents then read your mail (`give me my recent mail`) and send follow-ups after you click **Approve**.
- **Social media (Buffer):** Plugins → Connectors → **Buffer** → paste your API key from publish.buffer.com/settings/api (or set `BUFFER_API_KEY` in `.env` for the whole server). Then ask any agent or Chief of Staff: "post our launch on LinkedIn and X", "schedule this for Monday 9:30 am on all accounts", "what social accounts are connected?". Every post waits for your **Approve**. Instagram/TikTok/YouTube posts need media, which Buffer requires; text-only posts to those are refused with a clear message.
- **Other connectors** (Slack, Calendar, GitHub, Notion, HubSpot…): set `COMPOSIO_API_KEY` or a provider's CLIENT_ID/SECRET in `.env`.
- **Chief of Staff (orchestrator):** the first tile at the top of My Workplace. A new workspace starts with no agents: add them from **Plugins → Agents**, or ask Chief of Staff to build one. Ask it anything: it delegates to the right agents (in parallel), creates new agents from a description ("create an agent that tracks gym members and renewals"), and teaches any agent ("add to CRM's knowledge: rewiring is ₹500 per point").
- **New agents:** + → New agent → describe it (knowledge base is written for it), or **Build from requirements** → paste a spec → Analyze & build.
- **Reset:** stop the server and delete the `data` folder.

### Sign-in options (customers)
The login page offers **Continue with Google**, **Email me a sign-in code**, and **email + password**. Staff/admin accounts use email + password only.
- **Email code:** works out of the box locally. Without mail set up, the 6-digit code is printed in the `start.bat` window. Set `GMAIL_USER` + `GMAIL_APP_PASSWORD` in `.env` to email it. On Vercel, those two are required.
- **Google:** in console.cloud.google.com → APIs & Services → Credentials → *OAuth client ID* (Web application), add the redirect URI `<APP_URL>/api/auth/google/callback` (locally `http://localhost:3000/api/auth/google/callback`), then put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env` and restart. The same client also powers the Gmail/Calendar/Drive connectors (their redirect is `<APP_URL>/api/connectors/callback`; add both).

### Login problems
- **Unzip first.** Don't run it from inside the zip preview, OneDrive, or Program Files — put the folder on Desktop or Documents.
- Watch the `npm start` window: it prints the data file path. If it prints `*** Cannot write to …`, move the folder as above. It does not print passwords.
- Upgrading from an older zip? Stop the server, delete the `data` folder, start again (clears half-saved accounts).
- Open **http://localhost:3000** (served by `npm start`) — not the `index.html` file directly and not VS Code Live Server.
- Same port used by an old copy? Close every other `npm start` window, or set `PORT=3001` in `.env`.


An AI-agent workspace: customers run agents and request custom ones, the admin team reviews, quotes and takes payment, and everything is tracked.

- `index.html`: the whole site
- `lib/backend.js`: sign-in, access rules and storage (**Neon Postgres**, or a local file during development)
- `server.js`: runs everything on your computer (`npm start`)
- `api/index.js` + `vercel.json`: the same backend as a Vercel serverless function

## Deploy to Vercel with Neon Postgres

1. **Push to GitHub.** In this folder:
   `git init -b main && git add . && git commit -m "AgentSphere"`, create an empty repository online, then
   `git remote add origin <url> && git push -u origin main`.
2. **Import in Vercel.** Add New → Project → pick the repository. No build settings are needed.
3. **Add the database.** In the project: Storage → Create Database → **Neon (Postgres)** → connect it to this project. Vercel adds `DATABASE_URL` for you.
   (Using an existing Neon project instead? Copy its connection string from Neon → Connection details and add it as `DATABASE_URL`.)
4. **Set environment variables** (Settings → Environment Variables):

   | Name | Value |
   |---|---|
   | `SESSION_SECRET` | **required.** Long random text, e.g. the output of `openssl rand -hex 32` |
   | `ADMIN_EMAIL` / `ADMIN_PASSWORD` | the admin login created on first use (defaults: `admin@agentsphere.com` / `admin1234`) |
   | `TEAM_EMAIL` / `TEAM_PASSWORD` | the pricing-team login (defaults: `team@agentsphere.com` / `team1234`) |
   | `ANTHROPIC_API_KEY` | optional: turns on the Research, Finance, Support and Social agents |
   | `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | optional: use any OpenRouter model instead of (or as fallback to) Anthropic; `AI_PROVIDER=openrouter` makes it first |
   | `COMPOSIO_API_KEY` | optional: managed sign-in for Gmail, Calendar, Slack, GitHub, Notion and more (see Connectors) |
   | `TAVILY_API_KEY` | optional: web search for agents |
   | `CRON_SECRET` | needed on Vercel for scheduled routines (see Agent orchestrator) |

5. **Deploy** (or Redeploy after adding variables). The table `agentsphere_kv` and the admin accounts are created automatically on the first request.

If something is missing, the sign-in screen says what (for example "DATABASE_URL is not set").

## Run it on your computer

1. Install [Node.js 20+](https://nodejs.org/), unzip this folder and open a terminal in it.
2. `cp .env.example .env` (Windows: `copy .env.example .env`) and fill in what you need.
3. `npm install` (adds the Neon driver), then `npm start`, then open http://localhost:3000

Without `DATABASE_URL`, data is kept in `data/kv.json` on your computer. Put your Neon connection string in `DATABASE_URL` to use the same database as your Vercel site.

## Sign in

| Who | Choose | Email | Password |
|---|---|---|---|
| Customer | **User** | create one with "Create one!" | your choice (8+ characters) |
| Admin | **Admin** | `ADMIN_EMAIL` (default `admin@agentsphere.com`) | `ADMIN_PASSWORD` (default `admin1234`) |
| Pricing team | **Admin** | `TEAM_EMAIL` (default `team@agentsphere.com`) | `TEAM_PASSWORD` (default `team1234`) |

Change the default passwords before you share the site. Changing `ADMIN_PASSWORD` later does not change an existing admin; use **Settings → Change password**.
The 5-minute walkthrough is in [`docs/DEMO-SCRIPT.md`](docs/DEMO-SCRIPT.md).

## How data and sign-in work

- **Accounts:** passwords are checked on the server and stored as salted scrypt hashes. The browser never receives a password hash.
- **Sessions:** signing in returns a signed token (HMAC with `SESSION_SECRET`, valid 14 days). Every data request needs it.
- **Who sees what:** a customer only receives their own account, requests, payments and workspace. Staff (admin, pricing team) see all customers.
- **Who changes what:** a customer can only change their own data. Only an admin can suspend, delete or reset a customer. Roles can't be changed from the browser.
- **Storage:** one Postgres table, `agentsphere_kv (k, v, at, updated_at)`. It holds `as_users`, `as_requests`, `as_admin` and one `as_data:<email>` row per customer workspace, written last-writer-wins.

## My Workplace

A customer's single AI workspace (menu: **My Workplace**). Instead of a chat per agent, one assistant answers across all of the customer's agents and cites where each fact came from.

- **What it searches, per agent:** its capabilities, knowledge the customer added (paste text or upload `.txt`, `.md`, `.csv` or `.json`, up to 40 KB per item and 150 KB in total), completed run results, and its records (leads, jobs, slips, quotes, part orders).
- **How:** the question is ranked against all of that (BM25 keyword ranking, de-duplicated, at most three passages per agent). The best passages go to Claude with strict instructions to answer only from them and cite `[n]`. Broad questions ("summarize…", "latest…") pull the newest material from every agent.
- **Where it runs:** with `server.js` or Vercel, retrieval and the AI call happen on the server, from the signed-in customer's own workspace only (`POST /api/workplace/chat`). On the hosted claude.ai page they run in the browser on the customer's own data.
- **Without an AI key:** it shows the most relevant saved passages with sources instead of an answer, and says so.
- **Saved:** conversations and knowledge are stored with the customer's workspace (Neon on the server), so they follow the customer across devices.
- **Limits, stated in the UI:** no live access to outside systems. Answers come from saved data and say "as recorded on <date>". It is keyword retrieval, not vector search; swap in embeddings when knowledge grows beyond a few hundred passages.

## Agent orchestrator

Every agent — the built-in ones and any agent a customer creates with **+ → New agent** — runs through the orchestrator
(`lib/orchestrator.js`, tool loop in `lib/llm.js`) whenever `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` is set. The agent's
name, label and description become its persona; its Skills choice sets its speciality. In each reply the agent can:

| Tool | What it does |
|---|---|
| `search_my_data` | searches the agent's saved knowledge, run results and records |
| `read_connected_app` | reads live data from the customer's connected apps (see Connectors) |
| `remember` / `forget` | long-term memory per agent; shown in the agent's Settings → Memory, where the customer can delete items |
| `create_routine` / `list_routines` / `cancel_routine` | scheduled work ("remind me every 90 days", "check tomorrow at 9") — shown under Settings → Routines |
| `propose_action` | anything that sends or changes something in another app waits as an **approval card** (Approve / Decline); approved actions run through Composio |
| `ask_user` | asks one missing detail as a question card with a reply box |
| `web_search` | optional, with `TAVILY_API_KEY` |
| `ask_agent` | the Workplace Assistant delegates to the customer's other agents and combines the answers |

The chat shows what the agent did under each reply ("Created routines ⏱ Furnace filter due", "Saved to memory", "Read Gmail").

**Routines** run on their own. With `npm start` the server checks every minute. On Vercel, set `CRON_SECRET` and call
`GET /api/cron/tick` with `Authorization: Bearer <CRON_SECRET>` every few minutes — on a Pro plan add to `vercel.json`:
`"crons": [{ "path": "/api/cron/tick", "schedule": "*/5 * * * *" }]` (Vercel sends the secret automatically); on Hobby use
any external scheduler (e.g. cron-job.org). Results appear in the agent's chat with a notification the next time the
customer has AgentSphere open (it checks every minute).

Memories, routines, approvals and routine results are stored server-side (`as_mem:`, `as_rt:`, `as_appr:`, `as_inbox:`
keys) and are never sent through `/api/kv`. Deleting an account deletes them. Without an AI key, agents fall back to
quoting saved data. In the claude.ai preview (no server) agents chat with their persona but have no tools.

## Agents work in their own app from chat

Each app agent can do in chat what a user does in its app. It writes `<<DO: action || {json}>>` at the end of a reply; the page runs the action on the same records the app screens use and shows a result card (Open lead, All leads, copy blocks).

| Agent | Actions |
|---|---|
| FormFirst | `add_lead` (instant first reply + two-question qualify link), `qualify` (answers + intent, urgency, Hot/Warm/Cold, next step), `mark`, `questions`, `create_form` (link + embed code) |
| AfterJob | `add_job`, `rate` (1–5, 4–5 → review link, 1–3 private), `mark` |
| Nudge | `add_lead` (Day 0/3/7 sequence), `mark` |
| OpenPing | `add_quote` (agent writes the quote HTML, tracked link), `mark` |
| PartPing | `add_order`, `status` (ordered → shipped → arrived → ready) |
| ChangeSlip | `add_slip`, `void` |

Created agents get the same actions when their skill is one of these. The Workplace Assistant can act through any agent with `<<DO: Agent name.action || {…}>>`. The page sends the action list and current records to `/api/workplace/chat` as `app`; the server adds it to the agent's prompt. Actions only use real details from the user, never placeholders.

## Groups and task boards

Agents can be organised into **groups** (for example Desk, Factory, Growth) with a lead, a kanban board (todo / running / review / done / blocked) and a worker loop that runs todo tasks and moves them to review. Send a goal to a group and its lead breaks it into tasks. Anything outbound waits in review for your approval. Routines can be paused and resumed. See [docs/groups.md](docs/groups.md).

**Slack:** a Socket Mode bot (no public URL) takes DMs from one owner, routes `desk:` / `factory:` goals to groups, and posts review items with Approve / Reject buttons. See [docs/slack.md](docs/slack.md).

## Share links and live apps

**Share links (server mode).** Every link an agent shares is a real page served by this server under `/p/…`: lead form (`/p/f/`), qualify page (`/p/q/`), rating page (`/p/r/`), quote view (`/p/v/`), part status (`/p/t/`) and change slip (`/p/c/`). Customer answers are queued in `as_pub:<email>` and the owner's page applies them to the records every 20 seconds: new leads, qualified leads with an AI summary (intent, urgency, Hot/Warm/Cold, next step), ratings, quote opens, slip accept/decline. On Vercel, `vercel.json` rewrites `/p/*` to the API function. In the claude.ai preview there is no server, so links are placeholders and “Customer page” previews the customer side.

**Live apps.** Open an agent's settings → *Live app* → enter the app address and the account you sign in with (FormFirst, PartPing and ChangeSlip: your user account; AfterJob and Nudge: the admin account). The password is stored encrypted (`as_live:<email>`) and the app's session cookie is refreshed automatically. From then on the agent works inside that app through its own API and its prompt lists the app's real records:

| App | What the agent does there |
|---|---|
| FormFirst | submit a lead through your real form (FormFirst replies and asks question 1), pass the lead's answers into the conversation (FormFirst scores it), set new/contacted/closed, summarise, create forms (real `/f/<slug>` link) |
| AfterJob | create a job (real `/f/<token>` feedback link), record a score, close |
| Nudge | add a lead (follow-ups scheduled), set open/won/lost/paused |
| PartPing | place an order (real `/track/<code>` link), cancel |
| ChangeSlip | publish a slip (real `/slips/<id>` link), cancel |

Everything the agent does shows up in that app's own screens.

## Connectors

Marketplace → **Connectors** lists Gmail, Google Calendar, Drive, GitHub, Slack, Notion, Stripe, Shopify and 30 more.

- **Connect** opens the provider's official sign-in page in a pop-up (for example accounts.google.com → "Choose an account").
  After the customer approves, the provider sends them back to `/api/connectors/callback`, the server exchanges the code
  for tokens and stores them **encrypted** (AES-256-GCM, key derived from `SESSION_SECRET`) under `as_conn:<email>`.
  Tokens never go to the browser, not even to admins. **Disconnect** deletes them.
- Services without a sign-in page (Stripe — checked against Stripe before saving, Plaid, Vercel, Wix, Trello, Twilio, WhatsApp, PostgreSQL, Granola) ask for an API key
  instead, stored the same way.
- **Custom** (New Connector → Custom) saves a name and server URL for your own connector.

**Fastest way to turn connectors on: Composio.** Add `COMPOSIO_API_KEY` (from app.composio.dev) and redeploy. Connect then opens
Composio's hosted sign-in for that app (Google, Slack, GitHub, …), Composio keeps the tokens, and agents read the app through
Composio's read-only tools (`lib/composio.js`). Each customer maps to a hashed Composio user id, never their email. Disconnect
also removes the account at Composio. Stripe, Twilio and the other key-based connectors keep using their own keys.

To use your own OAuth app for a provider instead (takes priority over Composio):
1. Create an OAuth app in that company's developer console.
2. Set its redirect URL to `<APP_URL>/api/connectors/callback` (e.g. `https://your-app.vercel.app/api/connectors/callback`).
3. Put `<GROUP>_CLIENT_ID` and `<GROUP>_CLIENT_SECRET` in `.env` / Vercel env vars (see `.env.example`), plus `APP_URL`.
4. Google, Microsoft and some others review apps that ask for mailbox or file access before other people can use them.
   Until then only test users you add in their console can sign in.

Without a provider's keys, Connect says the connector isn't set up yet. In the claude.ai preview (no server) Connect opens the
service's official page in a new tab and explains that connecting needs the server.

**Agents use connected apps live.** When a customer asks the Workplace Assistant or any agent a question, the server
(`lib/live.js`) reads the relevant connected apps right then with that customer's own access, and the answer cites them
as "Live · Gmail", "Live · Stripe", … with a link back to the item. Read-only; nothing is changed in the apps.

| App | What agents can read |
|---|---|
| Gmail | recent / unread / matching emails (sender, subject, preview) |
| Google Calendar | events today, tomorrow or the next 7 days |
| Google Drive | files matching the question, or recently changed files |
| Outlook / Microsoft 365 | emails and the next 7 days of calendar |
| GitHub | pull requests and issues involving you, recent repositories |
| Slack | messages matching the question |
| Notion | pages matching the question, with their text |
| Stripe | balance and the latest payments |
| Box | files matching the question |
| Twilio | latest SMS |
| HubSpot | contacts matching the question |

Expired Google / Microsoft tokens are refreshed automatically. If an app can't be read (for example access was revoked),
the answer says so and asks the customer to reconnect it in Plugins. Other connectors are stored and shown as connected;
their readers can be added the same way in `lib/live.js`.

Logos: put official logo files in `logos/` and list them in `WP_LOGOS` (see `logos/README.md`).

## What is real and what is a demo

| Area | Status |
|---|---|
| Sign-in, accounts, roles | Real: server-checked, stored in Neon |
| My Workplace (one assistant across all agents) | Real retrieval over the customer's own agent data with cited sources; AI answers need `ANTHROPIC_API_KEY` |
| Requests → review → quote → pay → deliver | Works end to end, stored in Neon |
| The six tool agents (ChangeSlip, FormFirst, AfterJob, Nudge, OpenPing, PartPing) | **Run** opens each agent's live app; **Download** gives its code |
| Research / Finance / Support / Social agents | Real AI answers when `ANTHROPIC_API_KEY` is set |
| Payments | **Simulated checkout.** No money moves. Test card `4242 4242 4242 4242`, any future date, any 3 digits |
| Emails / SMS | Never sent. The agents write the text and you copy it |

## Before this is a production product

- A real payment gateway (Razorpay or Stripe) confirmed on the server.
- Real email and SMS delivery.
- Proper tables (users, requests, payments) instead of one key-value table, once the data model settles.
- Rate limits stored in the database rather than per server instance.

## Files

- `index.html`: the site
- `lib/backend.js`: backend logic (storage, sign-in, access rules, AI proxy)
- `api/index.js`, `vercel.json`: Vercel function and routing
- `server.js`: local server (`npm start`)
- `zips/`: the agent downloads (ZIP files stored as base64 text)
- `.env.example`: settings template
- `docs/DEMO-SCRIPT.md`: presenter's walkthrough
