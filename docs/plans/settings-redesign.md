# Settings redesign plan (Hermes-style)

Status: **plan only**, nothing built yet. Written 2026-10-17.
Goal: one admin Settings screen where an owner can do everything that today needs `.env` edits and a restart, laid out
like the Hermes Agent desktop app so ex-Hermes users feel at home.

---

## 1. What Hermes Agent's settings look like (researched)

Source: `NousResearch/hermes-agent` on GitHub, `apps/desktop/src/app/settings/` (Electron + React), plus
`website/docs/user-guide/configuration.md` and `cli-config.yaml.example`.

- Code: https://github.com/NousResearch/hermes-agent/tree/main/apps/desktop/src/app/settings
- Docs: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md (also https://hermes-agent.nousresearch.com/docs/)

**Layout (verified in code):** a settings page with a left list of sections and a right panel. Config sections have
sub-pages (tabs) and a settings search (`settings-search.ts`, `use-setting-deep-link.ts` = deep links to one field).

**Config sections** (`constants.ts → SECTIONS`, sub-pages in `config-subpages.ts`):

| Section | Sub-pages and keys (verified) |
|---|---|
| Model | Main (`model`, `model_context_length`, `agent.reasoning_effort`, `agent.service_tier`); Fallbacks (`fallback_providers`); Auxiliary (`auxiliary.*`, i.e. separate models for side tasks such as compression); MoA (`moa.*`, mixture of agents) |
| Chat | Behavior (`display.personality`, `timezone`, `display.show_reasoning`); Attachments (`agent.image_input_mode`) |
| Appearance | theme light / dark / system, language, interface mode, chat and terminal fonts, desktop pet |
| Workspace | Projects (`terminal.cwd`, repo scan roots / excludes); Shell (`terminal.persistent_shell`, `terminal.env_passthrough`); Files (`code_execution.mode`, `file_read_max_chars`) |
| Safety | Approvals (`approvals.mode`, `approvals.timeout`, `command_allowlist`); Privacy (`security.redact_secrets`, `security.allow_private_urls`); Checkpoints |
| Browser | Profile (`browser.use_real_profile`); Network (`browser.allow_private_urls`, auto-local for private URLs) |
| Memory | Persistent (`memory.*`); Context (`context.*`, `compression.*`) |
| Voice | Conversation, Transcription (`stt.*`), Speech (`tts.*`, `voice.auto_tts`) |
| Advanced | Desktop (`updates.*`), Runtime, Tools (`toolsets`, tool-use enforcement), Terminal (`terminal.*` backend), Delegation, Output (tool output limits) |

**Stand-alone views** (`types.ts → SettingsView`): `providers`, `keys` (provider cards grouped by env-var prefix:
Nous Portal, Fireworks, OpenRouter, Anthropic, xAI, … each with a signup link; secrets shown as `redacted_value`),
`gateway` (messaging gateway mode, keychain encryption, diagnostics), `connections`, `plugins` (install modal and
per-plugin settings form), `sessions` (auto-archive), `notifications` (per-kind toggles, completion sound), `vault`,
`keybinds`, `billing`, `about` (updates, update channel, uninstall). Files also show local models (download, hardware,
runtime), custom endpoints, computer use, terminal backend panel and quick-entry / screenshot shortcuts.

**config.yaml** (docs + the user's own backup) also has: `cron` (catch-up of missed runs), `kanban` (review dispatch,
max in progress), `terminal` backends (local, Docker, SSH, Modal, Daytona, Vercel Sandbox, Singularity), `skills`,
`delegation`, `display`, `telemetry`, `auth`, `updates`, `timezone`, `platforms` (messaging), `tool_loop_guardrails`,
`compression`, `prompt_caching`, `streaming`.

**Phanindra's own Hermes config** (`/workspace/hermes-restore/hermes-backup-20261016/hermes/config.yaml`, secrets
not read): default model `grok-4.5` via provider `xai-oauth`, OpenRouter plus a custom provider configured, kanban
review dispatch on with max 2 in progress, cron catch-up on, local terminal backend, a headed browser on his real
profile with private URLs allowed, memory and user profile on, compression on, `timezone: Asia/Kolkata`,
fallback providers set, MoA configured. The Kanban, cron, browser, memory, fallback and timezone settings are the
ones he really used, so they matter most to him.

**Not verified:** I did not run the desktop app or find settings screenshots (the repo's `assets/` only has
`banner.png` and `dmg-volume.png`), so the visual details (spacing, icons) come from the code only: a left nav with
lucide-style icons (Box, MessageCircle, Palette, Monitor, Lock, Globe, Brain, Mic, Wrench), a search box and sub-page tabs.

---

## 2. What AIdentify has today (audit)

**Settings tab** (`index.html`, `settingsHtml()`, around line 1803): Profile, Password & security (change password,
sign out everywhere), Appearance (system / light / dark), Preferences (task progress card, speak replies), "API keys"
(**demo only**: random `ask_…` keys that nothing checks), Your data (export JSON, reset), Danger zone (delete account).
Staff/admin see the same function inside the admin tabs. Per-agent settings exist separately (`wp-seth` panel: name,
photo, knowledge upload) and in the Groups tab's agents table (group, `model`, tools `sandbox`/`publish`/`ops`).

**Env-only (no UI), read through `process.env`** in `lib/` and `server.js`:
- AI: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`,
  `ANTHROPIC_BASE_URL`, `XAI_API_KEY`, `XAI_MODEL`, `XAI_BASE_URL`, `AI_PROVIDER`, `LLM_TIMEOUT_MS`, `TAVILY_API_KEY`, `WEB_SEARCH`.
- Slack: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_OWNER_USER_ID`, `SLACK_ACCOUNT_EMAIL`, `SLACK_AGENT_ID`,
  `SLACK_NOTIFY_CHANNEL`, `SLACK_HEARTBEAT_MIN`, `SLACK_WATCHDOG_SEC`.
- Browser: `BROWSER_PROFILE_DIR`, `BROWSER_HEADLESS`, `BROWSER_CHANNEL`, `BROWSER_EXECUTABLE`, `BROWSER_DISPLAY`,
  `REMOTE_BROWSER_IDLE_MIN`, `REMOTE_BROWSER_TUNNEL`, `NGROK_AUTHTOKEN`, `CLOUDFLARED_BIN`, `NGROK_BIN`, `NOVNC_DIR`.
- Tools/connectors: `GITHUB_TOKEN`, `GITHUB_OWNER`, `GUMROAD_ACCESS_TOKEN`, `BUFFER_API_KEY`, `COMPOSIO_API_KEY`,
  `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `<PROVIDER>_CLIENT_ID/SECRET`.
- Server/security: `SESSION_SECRET`, `ADMIN_PASSWORD`, `DATABASE_URL`, `PORT`, `HOST`, `APP_URL`, `RATE_LIMIT`,
  `DEMO_MODE`, `CRON_SECRET`.

**Hardcoded:**
- `lib/llm.js`: `max_tokens: 2000` for every call, no temperature, provider order anthropic → openrouter → xai,
  defaults `anthropic/claude-sonnet-4.5` and `claude-sonnet-4-5`; the per-agent `model` only applies when its id
  shape matches the provider (OpenRouter ids contain `/`).
- The live `deepseek/deepseek-v4-flash` comes from `.env` / per-agent `model` fields, not from any UI.
- Timezone `Asia/Kolkata` is the default in `lib/orchestrator.js` and `lib/slack.js`.
- Browser idle 10 minutes (`LIFE` in `lib/browser.js`); board worker every 20 s; step limits (6 default, 25 research).
- What needs approval is fixed in code (`SENSITIVE` regex in `lib/browser.js`, tool-by-tool approvals).

**Missing entirely:** usage and cost tracking (no token counts are stored), spending cap, OpenAI / Google / Ollama
providers, fallback model list, key testing, a model picker, Slack test, update check, backup/restore, logs view.

---

## 3. Proposed layout

Settings becomes a full-width page with a left nav (sections) and a right panel (cards with sub-page tabs), like
Hermes. A search box on top filters fields across sections and deep-links (`#settings/models/fallbacks`).

```
+---------------------------------------------------------------------------------+
| Settings                                         [ search settings...        ]  |
+----------------------+----------------------------------------------------------+
| > Models & keys      |  Models & keys      [Providers] [Defaults] [Per agent]   |
|   Usage & spending   |                     [Fallbacks] [Advanced]               |
|   Agents             |  +------------------------------------------------------+|
|   Approvals & safety |  | OpenRouter                         ● connected        ||
|   Messaging (Slack)  |  | API key  sk-or-••••••••3f2a   [Replace] [Test key]   ||
|   Browser            |  | Base URL https://openrouter.ai/api/v1                 ||
|   Schedules & board  |  +------------------------------------------------------+|
|   Connectors & tools |  | Anthropic                          ○ not set   [Add] ||
|   Memory & knowledge |  | OpenAI · xAI · Google · Ollama/local  ...            ||
|   Notifications      |  +------------------------------------------------------+|
|   Workspace & brand  |  Default model  [deepseek/deepseek-v4-flash  v] $0.x/M  |
|   Data & backup      |  Hard tasks     [ ...                         v]         |
|   Updates            |                                     [Cancel] [Save]      |
|   Security           |                                                          |
|   Logs & diagnostics |  "Saved. Applied live."  / "Needs restart: [Restart]"    |
|   About              |                                                          |
+----------------------+----------------------------------------------------------+
```

Mobile: the nav collapses to a section picker at the top.

## 4. Backend model (applies to every section)

- **Store:** one key `as_settings` (server-wide, admin) in the existing KV (`data/kv.json` or Neon). Optional
  per-workspace overrides later under `as_settings:<email>`.
- **Secrets:** encrypted with AES-256-GCM using the key derived from `SESSION_SECRET` (same helper as connector
  credentials in `lib/connectors.js`). The API only ever returns `{ set: true, last4: '3f2a', source: 'settings'|'env' }`.
  There is no endpoint that returns a full secret. Replacing a key needs the new value; clearing it needs a confirm.
- **Precedence:** `as_settings` value > `.env` > code default. Each field shows its source ("from .env", "set here",
  "default") and a "Reset to .env" link.
- **One reader:** a new `lib/settings.js` with `getSetting(key)` (cached, invalidated on save) replaces direct
  `process.env` reads in `lib/llm.js`, `lib/slack.js`, `lib/browser.js`, `lib/remote-browser.js`, `lib/factory.js`
  and others, so most changes apply **live without a restart**. Fields that cannot (PORT, HOST, DATABASE_URL,
  SESSION_SECRET) stay env-only and are shown read-only with an explanation.
- **API:** `GET /api/settings` (schema + values + sources, masked), `POST /api/settings` (`{ patch }`, validated per
  field), `POST /api/settings/test` (`{ kind: 'openrouter'|'slack'|'ngrok'|... }`), `GET /api/settings/models?provider=`.
  All admin-only (`who.role === 'admin'`), CSRF-safe (same token auth as the rest), rate-limited, and every change is
  written to an audit log (`as_settings_audit`: who, when, which key; never the value).
- **Schema-driven UI:** a single field schema (`key, section, subpage, type, secret, default, envName, live, validate`)
  renders the forms, the search index and the validation on both sides (Hermes does the same with its manifest).

## 5. Sections and controls

Legend: **N** = new, **E** = exists (moved or extended). "Live" = applied without restart.

### 5.1 Models & keys (phase 1)
| Control | N/E | Wiring | Validation |
|---|---|---|---|
| Provider cards: OpenRouter, Anthropic, xAI (exist in `llm.js`), **OpenAI, Google Gemini, Ollama / any OpenAI-compatible URL** (new) | E/N | key (secret), base URL, enabled toggle; OpenAI, xAI, Ollama and OpenRouter share the OpenAI-compatible path in `openrouterTurn`; Gemini via its OpenAI-compatible endpoint (verify) | **Test key**: a 1-token call or `GET /models`; shows ok, latency, error text |
| Default provider + default model | E (env) | `ai.provider`, `ai.model` (replaces `AI_PROVIDER`, `OPENROUTER_MODEL`, …); live | model picker filled from the provider's `/models` (OpenRouter `GET https://openrouter.ai/api/v1/models` gives `pricing.prompt/completion`, context length, tool support); warn if the model lacks tool calling |
| Task tiers: **Cheap** (routine, briefs, lead scans) and **Hard** (planning, Factory build, research) | N | `ai.tiers.cheap`, `ai.tiers.hard`; orchestrator picks the tier by task kind / step count; live | same picker |
| Per-agent override | E (Groups table `model`) | keeps `agent.model`; shown here as a table with "inherit" | picker; fix the `/` id-shape rule so overrides work for every provider |
| Fallback chain (ordered list) | N | `ai.fallbacks: [{provider, model}]`, tried on errors / 429 / timeout (today: fixed provider order) | each entry tested |
| Temperature, max output tokens, timeout | N (max_tokens hardcoded 2000; `LLM_TIMEOUT_MS` env) | `ai.temperature`, `ai.max_tokens`, `ai.timeout_ms`; per tier override; live | ranges 0–2, 256–32000, 30–600 s |
| Web search provider (DuckDuckGo / Tavily key / off) | E (env) | `search.provider`, `search.tavily_key` | Test search |

### 5.2 Usage & spending (phase 1)
| Control | N/E | Wiring | Validation |
|---|---|---|---|
| Usage table: today / 7 d / 30 d by agent, model, provider; tokens and estimated cost | N | `llm.js` records `usage` from each response into `as_usage:<yyyy-mm-dd>`; price from the cached `/models` pricing (OpenRouter also returns cost per generation, verify) | read-only |
| Monthly and daily spending cap (USD) + "at cap" action: pause routines and board / cheap tier only / warn only | N | `spend.cap_month`, `spend.cap_day`, `spend.action`; checked before each call | number ≥ 0 |
| Alert at 50 / 80 / 100 % | N | posts to Slack notify channel / DM | — |
| OpenRouter credit balance | N | `GET /api/v1/key` (verify field names) | — |

### 5.3 Agents (phase 2)
Defaults for new agents: tier, step limit (today 6 / 25 hardcoded), tools (`sandbox`, `publish`, `ops`), group,
"never claim without a tool result" rule (exists, keep always on), personality / tone text (Hermes `display.personality`
analogue) and a business-wide system note. Table of agents with model, tools, group and pause toggle (moves the Groups
tab table here, keeping a link there).

### 5.4 Approvals & safety (phase 2)
| Control | N/E | Wiring |
|---|---|---|
| Per action type: send email, social post, lead reply, browser pay/submit/sign-in, GitHub publish, Gumroad draft, shell in sandbox → "always ask" / "auto within limits" / "blocked" | N (fixed today) | `approvals.<kind>`; enforced where approvals are created; "auto" never allowed for pay/delete |
| Approval expiry (e.g. 72 h) | N | `approvals.expire_h` |
| Allowed / blocked domains for the browser and page reader | N (private hosts already blocked, keep) | `safety.domains_allow/deny` |
| Redact secrets in logs and tool output | N | `safety.redact` (on, locked) |

### 5.5 Messaging: Slack (phase 1)
Bot token, app token (secrets), owner user id, account email, DM agent, notify channel (picker filled with
`conversations.list` when the `channels:read` scope exists, else a text field), heartbeat and watchdog values.
**Test connection** (`auth.test`) and **Send test DM to owner**. Saving restarts only the Slack socket
(`stopSlack()` + `startSlack()`, both exist), not the server. Shows missing scopes. Telegram / WhatsApp are skipped (§8).

### 5.6 Browser (phase 2)
Agents' browser: profile folder, headless on/off, channel (Chrome / Chromium), idle close (today `LIFE` = 10 min).
Remote browser: idle minutes (`REMOTE_BROWSER_IDLE_MIN`), tunnel (auto / ngrok / cloudflared / none), ngrok token
(secret), **Open now** and **Close** buttons, current status. "Sign-in window" instructions. Test: tool check
(Xvfb, x11vnc, websockify, ngrok present) and a tunnel dry run.

### 5.7 Schedules & board (phase 2)
Timezone (default `Asia/Kolkata`; used by routines, briefs and Slack times), quiet hours, board worker interval and
parallel tasks per group, catch-up missed runs (Hermes `cron.catch_up_missed` analogue), list of routines with
pause/resume (API exists: `/api/routines/pause`), "pause everything" switch.

### 5.8 Connectors & tools (phase 2)
Cards for server-wide keys: GitHub token + owner, Gumroad token, Buffer key, Composio key, Gmail user + app
password, OAuth client id/secret per provider (with the redirect URL to copy), Tavily. Each: masked value, source,
**Test** (GitHub `GET /user`, Gumroad `GET /v2/user`, Buffer channels list, Composio auth check, Gmail SMTP verify).
Per-customer connections stay in Plugins → Connectors.

### 5.9 Memory & knowledge (phase 3)
Memory on/off per agent, max facts per agent, review/delete memories, knowledge base size limits, re-index, export
the knowledge base. (Today: `remember`/`forget`/`save_knowledge` tools and the Knowledge tab exist; no settings.)

### 5.10 Notifications (phase 3)
Per event (needs approval, task failed, brief, goal finished, spend alert, remote browser closed): where (Slack
channel / owner DM / email / in-app) and on/off. Today this is hardcoded in `lib/slack.js` `onBoardEvent`.

### 5.11 Workspace & branding (phase 3)
Business name, logo, colours, business type (onboarding pack), app name in emails/Slack, public `APP_URL`
(read-only if from env), customer-facing share-link footer. Profile, password and appearance stay (E).

### 5.12 Data & backup (phase 3)
Export all (JSON, secrets excluded or encrypted), scheduled backups to a folder or Google Drive (Drive connector),
**restore** from a file with a dry-run diff, reset workspace (E: today "reset" and "export my data").

### 5.13 Updates (phase 2)
Current version (`package.json`), latest release from `GET https://api.github.com/repos/aidendify/AaaS/releases/latest`,
changelog excerpt, "Check now", the update command (`npm run update`), and optional one-click update when the
server runs under a supervisor (runs `install.sh --update`, then restarts). Update channel: stable releases / main.

### 5.14 Security (phase 1 for admin password, rest phase 3)
Change admin and team passwords (today env defaults with a warning), sessions list and "sign out all", sign-in
methods on/off (password, email code, Google), rate limit (on/off, locked on for public servers), demo mode
(read-only warning), settings audit log viewer, `SESSION_SECRET` health ("set / default"), never editable here.

### 5.15 Logs & diagnostics (phase 2)
Tail of `server.log` with secrets redacted, health checks (AI provider reachable, Slack socket, browser tools,
tunnel, DB), "Download diagnostics bundle" (versions, settings with secrets masked, last 500 log lines).

### 5.16 About
Version, license, links (repo, docs, issues), "Run onboarding again".

**Access:** the whole Settings page (except Profile / password / appearance, which every user keeps) is visible only
to admins. Customers on a shared server keep the current personal Settings. Secrets are never shown in full after
saving: masked to last 4 characters, with Replace and Clear only.

## 6. Build phases and effort

| Phase | Scope | Effort (one dev) |
|---|---|---|
| 1 | `lib/settings.js` (store, encryption, precedence, cache), `/api/settings*`, schema-driven left-nav UI shell + search; **Models & keys** (all providers incl. OpenAI, Google, Ollama; Test key; OpenRouter model list with prices; default, tiers, per-agent, fallback, temperature, tokens, timeout); **Usage & spending** (usage recording, cost, caps, alerts); **Slack** (fields, test, live socket restart); admin password; migrate `llm.js` and `slack.js` to `getSetting` | 5–7 days |
| 2 | Agents defaults, Approvals & safety, Browser + remote browser, Schedules & board + timezone, Connectors & tools with tests, Updates check, Logs & diagnostics | 5–6 days |
| 3 | Memory & knowledge, Notifications routing, Workspace & branding, Data backup/restore, rest of Security (sessions, sign-in methods, audit viewer), polish, mobile layout, docs | 4–5 days |

Each phase: unit tests for precedence/masking/validation, a migration that imports current `.env` values as
"from .env" (nothing is copied, only shown), docs update, and a release.

## 7. Risks

- **Secret leaks** through the API, logs or exports: one masking function, no full-secret endpoint, tests that grep
  responses for known test secrets.
- **Lock-out:** a bad key or cap that stops all agents. Mitigate with Test before save, keep the last working value,
  `.env` fallback, and a "safe mode" env flag that ignores `as_settings`.
- **Live reload bugs:** modules caching env values at import (e.g. `CHROME_BIN`, timers). Audit each and document which
  fields need a restart.
- **Cost numbers are estimates** (prices change, some providers return no usage): label them "estimated".
- **Multi-tenant confusion:** server-wide vs per-customer settings. Phase 1 is server-wide admin only.
- **index.html size** (~475 KB single file): build Settings as its own `settings.html` loaded like `board.html`.
- Provider APIs used for model lists and balances must be re-checked at build time (marked "verify" above).

## 8. Deliberately skipped

Hermes features that do not fit AIdentify (a hosted web app, not a desktop coding agent): terminal backends
(Docker/SSH/Modal/Daytona/…), keybinds, desktop pet, quick entry and screenshot shortcuts, voice STT/TTS settings,
local model downloads and hardware panel (Ollama URL is enough), MoA / mixture of agents, context compression and
prompt-caching knobs, plugin marketplace, billing, uninstall, telemetry (AIdentify has none). Telegram, WhatsApp and
Discord gateways are out of scope until the Slack path is solid. No editing of `.env` itself from the UI.
