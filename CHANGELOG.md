# Changelog

All notable changes to AaaS are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Monthly calendar.** A Calendar screen in the clinic shows a month grid with visit and scheduled-post counts per day. Tap a day to see its items and add a visit or draft a post for that day, using the existing appointment and social draft APIs. Post drafts still wait for approval.

## [2.7.0] - 2026-10-28

### Added
- **Chat first.** After sign-in, and for the sample business, the owner lands in a chat with Chief. Chief opens with today’s open enquiries, drafts waiting for approval, unpaid invoices and visits booked today. Questions are answered from that account’s records. A Chief button on every Advanced screen opens the same chat.
- **Advanced.** The top-right switch (the old Bot Mode control, flipped) opens the full dashboards, approvals, agents and the rest of the clinic. Chat stays the default. The choice is remembered per account.
- **Home.** One page with the recovered figure, open enquiries, the approval inbox, payments due, today’s visits and revenue. Approve and Edit sit on the cards. Details open in a side drawer.
- **One theme.** `clinic-theme.css` holds the colours, Inter, radius and shadow used by chat, Home, sign-up, the wizard, pricing and settings.

### Changed
- Drafts still need approval in chat and in Advanced.

## [2.6.0] - 2026-10-28

### Added
- **Clinic workspace at `/clinic`.** An owner signs up, adds the business, and picks an industry. Seven packs share the same screens: Dental, Skin/Hair/Aesthetic, Coach/Consultant, Real estate, Salon/Gym/Studio, Interior/Home services, and Coaching institute. Each pack has its own names, sample rows and prompts. The six agents are Front Desk, Follow-up, Reviews & Referrals, Social Media, Owner Insights, and Billing & Invoicing.
- **Dashboard.** The hero is rupees recovered this month, counted once from bookings, reactivated customers, referrals and paid invoices. A weekly WhatsApp summary is drafted into Approvals. Next month is a forecast from the last 28 days. Sample rows are marked DEMO.
- **Approvals first.** Enquiries, reminders, review requests, posts, referrals and payment reminders stay drafts until the owner approves them. Approving records the OK. With no WhatsApp provider key, nothing is sent and the link stays a click-to-chat `wa.me` link.
- **Billing for the owner’s customers.** Manual invoices, optional GST left blank when there is no GSTIN, print and PDF, paid or unpaid. A Razorpay test key adds a payment link; otherwise the invoice uses a UPI link. A signed webhook marks the invoice paid. The sample business can simulate that. AaaS does not take the payment.
- **WhatsApp.** Meta Cloud API and Gupshup can send one approved template when those env keys are set and the person has opted in. Opt-out blocks a later send. Without those keys, drafts stay click-to-chat.
- **Connections.** CSV import, the public booking form, and Eka.care when server credentials are set. The sample business shows Connected (demo) and does not call Eka. Other software can POST a webhook when `CLINIC_CONNECTOR_WEBHOOK_SECRET` is set.
- **15-minute setup.** Industry, business details, import (CSV, paste or Eka), WhatsApp number, a tone sample, and an AI key. It ends with the first three drafts in Approvals. Book a setup call saves the request and does not email anyone.
- **Your own AI key, required.** Settings and the setup wizard save an OpenRouter, OpenAI, xAI, Gemini or Anthropic key. It is checked once, stored encrypted, and only the last 4 characters are shown. Clinic agent calls use that key only. Without a saved key they are refused. `CLINIC_DEMO_PLATFORM_KEY=1` (staging sample only) allows the server key, labelled “Demo key, demo only”, and the setup step shows “Continue with demo key (demo only)”. That button is absent when the flag is unset.
- **Two plans, both bring-your-own-key.** Prices live in `lib/pricing.js`. Self-hosted is ₹2,999 a month for updates and support, plus a one-time setup and install of ₹9,999, waived on an annual plan. Hosted is ₹4,999 a month: we run it, with backups, uptime and updates, and no install. Both plans include the same agents. AI usage is paid by the client to their provider. The app does not charge a card.
- **Bot Mode.** A switch at the top right of every clinic screen. On (`/clinic#bot`) opens the existing workplace chat for this account’s agents, and conversations continue there. Off returns to the dashboards. The choice is remembered per account. Drafts still need approval.
- **Landing v2.** When `AIDENTIFY_SITE=landing`, `/` serves the small-business page. `/v2` still serves it. v1 stays at `/v1`. `/white-label` is the agency page.

### Changed
- The cost meter is informational: “Usage on your <provider> key, paid to your provider”.
- An old expiry stamp does not lock the clinic workspace.
- The product name is AaaS (Agents as a Service) on titles, the app, emails, public pages and docs. Vercel projects, domains, env vars, the npm package name and database names are unchanged.

## [2.5.0] - 2026-10-20

### Added
- **Telegram.** Each account pastes a BotFather token on the Inbox page. The webhook URL has a hook id and no token in it. `X-Telegram-Bot-Api-Secret-Token` must match the secret stored for that account. The owner’s private messages go to the Chief of Staff. Customers reach the front desk only if the owner turns that on. Those replies start as needs approval. The front desk still cannot be set to full auto. There is no per-message fee.
- **Slack, per account.** A bot token and a signing secret, separate from the server-wide Socket Mode bot. The raw body is checked with `X-Slack-Signature` and the timestamp before the event is trusted, including the URL-verification challenge. DMs and mentions from the owner go to the Chief. Customers reach the front desk only when that is turned on.
- **WhatsApp QR (beta, owner only).** Off unless `WHATSAPP_QR=on`. The linked number is the only number that can talk to the Chief, in the chat with itself. Other people, groups and broadcasts are ignored. It cannot message customers or send a broadcast. The Inbox page shows that this is unofficial and that WhatsApp can restrict the number. On Vercel and other serverless hosts it does not open a socket, and the rest of the app keeps working. It needs a server that stays running.
- **Encrypted per account.** Tokens and the WhatsApp QR session sit in the same sealed channel credentials as the Cloud API token. Logs and `GET /api/channels` show a hint, not the secret. Webhook ids are not written into the request log.

### Notes
- A Chief reply in the owner’s own Telegram, Slack or WhatsApp QR chat is delivered, because that is the conversation. A message to a customer still waits in Approvals.
- A Telegram or Slack token that starts with `mock_` is rejected unless `CHANNELS_MOCK=on`. With that switch and `AI_MOCK`, tests run without Telegram, Slack or WhatsApp. The signature check still runs.
- This build does not deploy the change. Setup steps are in `docs/CHANNELS.md`.

## [2.4.1] - 2026-10-20

### Changed
- **Audience widened to Indian small business owners** (approved by Phanindra, 20 Oct 2026). Landing page hero is now "Never miss a lead again. Your AI front desk on WhatsApp." with a new subhead, title and meta description. "Who it's for" has six cards: clinics (enquiries and appointments only), coaches and consultants, real estate brokers, interior designers and home services, institutes/salons/gyms/studios, and agencies as white-label resellers. FAQ and early-user copy updated; pricing FAQ says there are no online payments yet.
- **Business type picker.** The waitlist form and the in-app onboarding both offer the same 15 business types, with no default selected. A choice is required. The onboarding picker used to preselect "Clinic / dentist".
- Chief of Staff's business profile line now shows the readable business type.

## [2.4.0] - 2026-10-20

### Added
- **Agency workspaces.** A customer can turn their login into an agency and add client workspaces and staff. Each client is still their own account, so one client cannot read another, and one agency cannot read another agency’s clients. Staff roles are owner, admin, and member.
- **Branding.** Name, logo, colours, support email, and a hostname. The login page on that hostname, the app after sign-in (name, logo, and the colour on the top bar and primary buttons), sign-in and password-reset wording, and the website chat use it. DNS setup is documented. Saving a hostname does not change DNS or issue a certificate.
- **Playbooks into a client.** Install writes only after confirm. Workflows stay drafts. Nothing is enabled or sent.
- **Per-client usage and caps.** AI calls, AI cost, messages, and leads for the month. A full cap blocks the new call, message, or lead.
- **Manual usage summary.** CSV and a printable HTML page, with the agency’s markup. AI stays in USD and messages and leads stay in INR. No payment is taken.
- **View as a client.** Owner or admin only. An audit line is written first. The session is read-only and lasts about two hours.

### Notes
- This is still the current per-account store. It is not organisations, memberships, or row-level security, and it is not a LangGraph runtime.
- Billing and Razorpay stay shelved. The summary is for an invoice you raise yourself. It is not a tax invoice.
- Mail to a client’s contacts sends only from the Gmail that client connected. The platform mailbox is not used for that. Creating a client does not send email. Sign-in codes and password resets still use the server mailbox, with the agency’s name on them.
- A cap is checked when the action runs. It is not a lock across every process. The website chat rate limit is still per process. The hosted routine tick is still often once a day.
- View-as cannot send, change, or open the agency. A member cannot view-as. The Back to agency bar stays on screen, and the business-setup form does not open.

## [2.3.0] - 2026-10-20

### Added
- **One inbox per account.** WhatsApp, SMS and email sit on the Inbox page, matched to a CRM contact and written onto that contact’s timeline. Credentials are stored encrypted, the same way a bring-your-own AI key is stored. The page and `GET /api/channels` show a hint, not the secret.
- **WhatsApp Cloud API.** Each account pastes its own phone number id, access token and app secret. The webhook URL has no account id in it. The account is chosen from the phone number id, then the signature is checked with that account’s app secret. A verify token is shown once. Outside 24 hours of the last inbound message, a free-form reply is refused and a template name is required. The whole message `STOP` (and the usual opt-out words) sets consent to Opted out and nothing is sent back.
- **SMS adapter.** Twilio, MSG91, or `mock`. Inbound SMS is routed by the destination number you saved, then checked with that account’s secret. MSG91 can carry a sender id and a DLT template id you already have. This build does not register DLT for you.
- **Inbound email.** Sync uses the Gmail connection already on the account. With the test switches on, a mock inbound email can be posted for the signed-in account only.
- **Workflow sends.** A sentence can add a WhatsApp step or an SMS step. Both start as needs approval, use the same approval queue, and keep the contact-only rule, the step cap and the account ceiling. Opt-out skips them. A WhatsApp outside the 24 hour window waits unless the step names a template.
- **Front desk.** Answers inbound WhatsApp and the website chat from this account’s business profile and FAQs, asks what the lead wants, and can offer call times (Monday–Friday 10:00–18:00 Asia/Kolkata by default). A reply is a draft unless you turn on auto within limits. Full auto is not available. If the desk is unsure, or the message tries to change the rules, it hands the chat to you and does not send.
- **Website chat.** Each account can create an embeddable widget. The token is unguessable, the script is rate limited, and drafts are not shown to the visitor. Setup is in `docs/CHANNELS.md`.

### Notes
- This is still the current per-account store. It is not a separate database, and it is not a LangGraph runtime.
- Mock providers (`mock_` WhatsApp tokens, SMS provider `mock`, and `CHANNELS_MOCK` together with `AI_MOCK`) let the tests run without Meta, Twilio, MSG91 or Google credentials. The signature check still runs.
- A webhook cannot name an account. Two phone number ids in one payload are rejected. Deleting an account removes the number indexes and the widget token.
- The 24 hour window is the last inbound message stored here, not a call to Meta’s window API.
- The front desk decision is rules. The model may only make it more cautious. Inbound text never changes autonomy.
- A booking is saved when the confirmation is actually sent. Google Calendar is optional. A mock calendar link is available only with the test switches on.
- The widget rate limit is per process. The hosted routine tick is often once a day, so a workflow send waits for that tick.
- Voice is not included. Embedded Signup is not included.

### Review fixes (PR #3)
- Approved emails from customers send only from their own connected mail; the server's mailbox is used only for the server owner (`allowPlatform`).
- Playbook import: 256 KB cap; scripts, iframes, event handlers and `javascript:` links stripped; specific addresses dropped from `allowed_recipients`; outbound steps still locked to needs approval.
- Playbook export: emails and phone numbers in prompts/templates replaced with "[contact removed]".
- Tests: test/review-pr3.test.mjs; e2e scenario j (weekly review on the test clock, apply, export/import preview/install, cross-account 404).

## [2.2.0] - 2026-10-20

### Added
- **Weekly suggestions.** On the same routine tick as workflows, each account is reviewed about once a week. The review reads only that account’s timeline, email opens and clicks, workflow runs and approvals, and writes 3 to 5 plain sentences. For example: “Emails sent on Tuesday get about 2× the opens of other days” or “Leads from LinkedIn convert best.” Open them on the Suggestions page.
- **Apply does not send.** Apply on a suggestion saves a draft workflow, or a change that still needs a separate Confirm. A draft stays off until you turn it on. Confirm copies words or remembers a preference. It does not send, post or pay, and it does not change a step’s approval setting or its send caps.
- **What the account learns.** Shortening a subject twice, repeating a greeting, or rejecting a draft with a note is remembered for that account and used the next time a sentence becomes an email. You can still set a step to auto afterwards.
- **A/B tests on an email step.** Two subjects and bodies are split across contacts. Opens and clicks are counted. Auto-pick copies the winning words only when you already set that step to auto or auto within limits. It never sends, and it leaves the approval setting, the step cap and the account ceiling alone. Otherwise the winner waits for Apply, then Confirm.
- **Playbooks.** A playbook is workflows, agent notes, pipeline stages, custom fields and email templates. Export writes JSON for this account with no contacts and no secrets. Preview lists what will be created. Install writes only after you confirm. Built-in starters cover an agency, a digital marketing business and an email marketing business. There is no real-estate starter.
- **Installed workflows stay drafts.** Send, post and pay go back to needs approval. Installing does not turn a workflow on and does not send anything.

### Notes
- This is still the current per-account store. It is not a separate database, and it is not a LangGraph runtime.
- The weekly review runs on the existing routine tick. On the hosted app that tick is often once a day, so a review that is due is picked up on the next tick.
- “Tuesday” means that weekday in UTC, on the tick that ran the workflow.
- An A/B email gets a tracking image and rewritten links so opens and clicks can be counted. The email still waits for approval, or for the send caps, before anything goes out.
- Auto-send still has the limits from v2.1: only the contact’s own address, the step’s daily cap, and an account ceiling (`WORKFLOW_SEND_DAILY_MAX`, default 50, and 0 means none). Workflow mail never uses the platform mailbox.
- Suggestions are for this account only. A playbook you export is visible only to this account. The starters are built in. This is not a public marketplace.
- Nothing in Apply, Confirm, auto-pick or Install sends an email.

## [2.1.0] - 2026-10-20

### Added
- **Workflows in plain English.** On the Workflows page, describe what should happen in a sentence. For example: “When a new lead comes from LinkedIn, tag them, draft a welcome email, and remind me in 2 days if no reply.” The same AI you already use (OpenRouter, or the free test AI) turns that into a trigger and steps. You read it back in ordinary words, then turn it on, pause it, or delete it. Run history sits on the same page.
- **What can start a workflow.** A new lead, a stage change, a tag being added, an email open, a link click, a form submission, or a schedule such as every morning.
- **What a step can do.** Tag a contact, change their stage, add a note or a task, draft an email, send an email, prepare a post, record a payment step, wait, or remind you in the app.
- **Each step has a setting.** Needs approval, auto within limits (a daily cap and an allowed-recipient list), or auto. Anything that sends, posts or pays starts on “needs approval” and lands in the Approvals queue you already have. You can change an email step after you have read it. Posts in this version still wait as drafts. A payment step never charges anyone.

### Notes
- This is still the current per-account store. It is not a separate workflow database, and it does not use a new agent runtime.
- Runs happen on the existing routine tick (every minute on a self-hosted box, or when the daily hosted job runs). A wait of two days finishes on the first tick after those two days.
- “They replied” means the contact’s history has a line that says they replied. A real inbox reply is not read yet.
- “Every morning” means once a day on that tick, not a guaranteed clock time.
- Approving a draft still does not send or post it. An email is sent only when that step is set to auto (or auto within limits), the recipient is allowed, the daily cap is not used up, and email is connected. If it cannot send, it waits in Approvals and nothing goes out.
- Turning a sentence into a workflow needs an AI key, or the free test AI. The test AI gives the same workflow every time for the same sentence.

## [2.0.0] - 2026-10-20

### Added
- **One timeline per contact.** Open Contacts, pick a lead, and you see one list in time order: history, notes, stage changes, tasks, emails and drafts that are waiting for approval, agent runs that named that contact, form submissions, and page visits. Add a note or a task from the same page. Nothing on this page sends, posts, or pays.
- **A small dashboard.** The Contacts page shows how many leads you have, where they came from, how they sit in the pipeline, and how many have reached Won. It also counts email opens, link clicks, and page views for your account only.
- **Email open and click tracking.** You can put a tracking image and rewritten links on an email that is still waiting for approval. Approving that email is still a separate step. Opens and clicks show up on that contact’s timeline. A contact marked Opted out is not tracked, and new tracking links are refused for them.
- **Where a lead came from.** A public form records the campaign tags on the link (source, medium, campaign, and the usual ad click ids) and adds a visit plus the form submission to that contact’s timeline. A page-visit link does the same for a page you share yourself.

### Notes
- This is still the existing per-account store, not separate database tables, organisations, or row-level security. Those stay on the later v2 plan.
- Tracking is not added to an email by itself. You add it to a draft, then you approve the draft before anything is sent.
- An open, a click, or a visit does not start an agent. Older chats are not copied onto the timeline; only a new chat that includes the contact’s email is recorded, and the prompt text is not stored.
- The open image is a rough signal (many mail apps block images). Plain-text emails get rewritten links only.
- There is no site snippet, consent banner, or download/delete-my-data flow in this release.

## [1.15.0] - 2026-10-20

### Added
- **CRM settings screen.** Account menu → "Leads: fields, stages, CSV". Set your pipeline stages and your own lead fields there, without the API. The CRM refreshes by itself after an import or a settings change.
- **Backups and a restore drill.** `scripts/db-backup.mjs` backs up the database to a checked, optionally encrypted file. It restores into a new schema (never over live data by accident) and runs a full restore drill. The first drill on staging passed: 13 rows restored in 7 seconds, and the copies matched exactly. See docs/BACKUPS.md.
- **Monitoring endpoint.** `/api/health/deep` shows whether the database answers (it returns 503 when it doesn't), the version, whether AI is ready, and when the daily routine run last happened. It holds no customer data. docs/MONITORING.md has the uptime and error alerting plan.
- **One-command rollback.** `scripts/vercel-rollback.sh <project>` switches back to the previous deployment instantly, and `undo` switches forward again. The live demo asks for a typed "yes" first.
- **Cost notes** (docs/MONITORING.md) and an **AWS deployment plan** in Mumbai, inside a private network (docs/DEPLOY-AWS.md). These are documents only; nothing was created on AWS.
- Staging tests now also cover app connections, approvals (edit, reject with a note, batch, history, clear) and the CRM (fields, stages, CSV import and export, tags), each checked against a second account.

## [1.14.0] - 2026-10-20

### Added
- **Connection status for your apps.** Each connected app now shows Connected or Reconnect needed. A new "check" tests Gmail and Slack right away (Gmail app passwords over SMTP, Google sign-in, and Slack). When an app stops working, for example an expired sign-in, it's flagged with a plain reason. To reconnect, connect it again; disconnecting tells you whether anything was actually removed.
- **Smoother approvals.** A new Approvals screen (account menu):
  - Edit an email (to, subject, body), a post or a draft before approving it.
  - Reject with an optional reason.
  - Tick several items to approve or reject them together (up to 25, with a confirm step).
  - See the full history: what was approved, rejected or edited, and the result.
  - Clear decided items; anything still waiting is kept.
  - Nothing is sent, posted or paid until you approve that exact item.
- **A more flexible CRM.**
  - Your own custom fields: text, number, date, a pick-list, or a checkbox.
  - Your own pipeline stages. Removing a stage moves its leads to another stage and records it.
  - Add or remove tags on many leads at once, and filter by tag or stage.
  - CSV import with a check step first. It shows new, updated, skipped and problem rows before anything is saved, and duplicates are skipped unless you choose Update.
  - CSV export, made safe to open in spreadsheets.
  - Every change goes into the lead's history, ready for the contact timeline in v2.

## [1.13.0] - 2026-10-20

### Security
- **Customers are kept strictly apart.** We checked every API route and added tests that sign in as one customer and try to read, change or delete another customer's leads, routines, approvals, memories, chats, activity and settings. All of it is refused.
- **Shared admin settings are staff-only.** A customer could set the plans and payment-gateway name before an admin had saved them. Now a customer can only add their own payments.
- **The owner's signed-in browser is only for the owner.** Before, another account's research or browser agent could use the owner's signed-in browser profile. Other accounts now always get a fresh, empty browser.
- **The remote browser is off by default.** It needs `REMOTE_BROWSER=on` on a self-hosted server and is always off on the hosted version. It stays owner/admin only, with time limits and an audit log.
- **Deleting an account also deletes its agent activity history.**

### Changed
- Billing (Razorpay and GST invoices) is shelved until there is a GSTIN. Early customers are invoiced manually.

## [1.12.0] - 2026-10-20

### Added
- **Agent activity.** A new "Agent activity" item in the account menu shows every agent (Chief of Staff first): whether it's ready, waiting for your approval, or its last run failed; when it last ran and how long it took; the steps it took; its routines and next run time; and its recent errors in plain words.
- **See the agent working.** While the Chief of Staff or an agent is answering, the chat now shows each step as it happens (for example "Searched saved data", "Read Gmail", "Draft waiting for your approval") instead of only three dots.

### Notes
- True word-by-word streaming of answers is not in this release: agents use tools in several rounds, and the live steps give most of the "it's moving" feel at a much lower cost. Approval-first is unchanged; nothing sends, posts or pays on its own.

## [1.11.0] - 2026-10-19

### Changed
- **One sign-in screen.** Sign in, Create account and Forgot password are now three tabs on the same screen. Old links like `/login`, `/signin`, `/signup`, `/register`, `/forgot-password` and `/reset-password` all lead there. Admins still sign in from the same screen with the User / Admin switch, and `/setup` still creates the first admin. Google sign-in stays hidden until it's set up.
- **Clear password rules.** When you create an account or set a new password, the rules show under the box and tick off as you type: at least 8 characters (12 for staff), and not a common or easy-to-guess password. The server checks the same rules.
- **Friendlier lockouts.** The limits are unchanged: 10 wrong passwords per email and 50 per network in 15 minutes, and only wrong passwords count. When you have 3 tries or fewer left, the message tells you how many. When sign-in is paused, it tells you how many minutes to wait and points you to "Forgot password?".

### Added
- **Show/hide password** on every password box: sign-in, new password, change password, delete account, and the API key boxes.
- **Password reset.** "Forgot password?" emails you a link that works once and expires after 30 minutes. Only a scrambled (hashed) copy of the link's code is stored, and asking again cancels the old link. After a reset, the old password stops working and every other session is signed out. The screen never says whether an email has an account. Requests are rate-limited to 3 per email and 20 per network every 15 minutes. If the server has no email sender, the screen says so plainly instead of pretending an email went out. New endpoints: `POST /api/auth/forgot` and `POST /api/auth/reset-password`.
- Tests: unit tests for password rules, the reset link's life cycle and the lockout messages. There's also a new end-to-end scenario **f**: a weak password is refused, a strong one works, then reset, the old password is refused and the new one works. On mock-AI servers only, the reset reply includes the code for throwaway `e2e-*@example.com` accounts so the test can finish the flow. It never does this on the live demo.

## [1.10.0] - 2026-10-19

### Added
- **Leads API.** Scripts, website forms and automation tools can now add one lead at a time to your CRM with `POST /api/leads`. They can also list, read, change and delete leads (`GET`, `PATCH`, `DELETE /api/leads/:id`). The leads show up in the app's CRM straight away. See `docs/API-LEADS.md`.
  - The same email or phone isn't added twice. You get the existing lead back, and can update it with `"upsert": true`.
  - Add `followUp` (for example "in 3 days") and the CRM agent drafts the follow-up for your approval at that time. Nothing is ever sent automatically.
  - Each account only ever sees and changes its own leads. Saves at the same moment don't overwrite each other: 8 leads added at the same instant on staging all arrived.
- The end-to-end suite has a fifth journey covering the leads API.
- **Team handover plan** in `docs/TEAM-HANDOVER.md`: what is built, known issues, the roadmap from v1.10 to v2.8, and the stress-test steps to repeat for every release.

## [1.9.0] - 2026-10-19

Faster, safer and more useful for new accounts. These fix the top problems the v1.8.0 tests found.

### Changed
- **Much faster hosted app.** The app's servers moved next to the database, in Singapore (close to India). Each page now asks the database fewer questions.
  - Measured on staging, server time, before → after:
    - Plain AI request with test AI: 1.1 s → 0.014 s.
    - Account delete: 4.2 s → 0.07 s.
    - Loading a workspace: 0.9 s → 0.01 s.
  - Agent chat with real AI went from about 20 s to about 6 s typical.
- **Your data stays yours, and loading it no longer reads everyone's.** Loading a workspace now reads only your own records instead of scanning the whole database.
- **No more hanging on slow AI.** When the AI is slow, you get a clear "took too long, try again" message within 50 seconds, instead of the request being cut off. Public lead and quote pages never make a visitor wait more than about 8 seconds. If the AI is slow there, they use the built-in reply.

### Added
- **Business profile at signup.** New accounts can describe their business in one line, and add more later through `/api/profile`. Every AI draft, agent chat and scheduled routine starts from it, so posts mention the right business without being told each time.
- **Approvals work from day one.** Without connecting any app, the agent puts posts, replies and emails in your approval queue as drafts. Approving a draft sends nothing: you copy it and post it yourself. Apps connected with only a key, such as Trello, now give a clear "approved draft" instead of an approval that always failed.
- **One-off follow-ups through the API.** `POST /api/routines` accepts `run_at`, for example "follow up in 3 days", and an optional repeat.
- **Daily scheduler.** The hosted app runs due routines every morning at 08:00 IST. Instructions for a free every-minute pinger are in `docs/STAGING.md`.
- `test/e2e/bench.mjs` measures speed on any copy of the app.

### Fixed
- Deleting an account now removes its rows completely instead of leaving empty ones behind. It also removes its email from the AI spend log; the totals stay.

## [1.8.0] - 2026-10-19

Real-customer journeys tested from start to finish (stress-test plan, phase 1).

### Added
- **End-to-end test suite** (`npm run e2e -- --base <url>`). It runs four real journeys against a live copy of the app. Each creates throwaway accounts and deletes them afterwards.
  - **Agency owner:** saves a business profile, drafts 10 posts and replies, and approves or rejects the agent's proposals.
  - **Lead flow:** a visitor fills in the quote form, the lead appears in the CRM, a follow-up is scheduled and actually runs.
  - **Own AI key:** wrong keys, out-of-credit keys and revoked keys all give clear errors and never fall back to our shared key.
  - **Outside script:** logs in, sends tasks, and is refused with fake, changed or logged-out tokens.
- **Test report** (`test/e2e/REPORT.md`) with pass/fail, timings, AI cost and every problem found, ranked by severity.

### Fixed
- Sending broken data to the hosted API now gets a clear "not valid JSON" answer instead of a server error.
- Deleting an account now also switches off its public links (lead forms, quote and rating pages). Before, those links kept pointing at the deleted account and its email.

### Results
- On the staging copy all four journeys pass, with free test AI and with real AI. The real-AI run cost about a quarter of a cent.
- Nothing was sent or posted without approval, including when a message tried to trick the agent into emailing and posting.
- Bigger issues found are listed in the report for the next phase. The main ones:
  - Loading a workspace reads the whole database.
  - Every request has noticeable fixed delay.
  - Slow AI answers come close to the hosting time limit.
  - New accounts can't get approvals until they connect an app.
  - Scheduled work only runs when something triggers it.

## [1.7.1] - 2026-10-19

A safe place to test (stress-test plan, phase 0). Nothing changes for demo users.

### Added
- **Staging copy** at https://aidentify-staging.vercel.app. It has its own database area, its own $2 AI budget and its own passwords, so test runs never touch the live demo or its $10 AI budget. See `docs/STAGING.md`.
- **Free test AI ("mock AI").** It gives fixed, made-up answers with made-up costs, so tests cost nothing. It only switches on when two separate settings are both set, and it never quietly falls back to paid AI.
- **Request log.** Every API call now writes one short line with which page was called, whether it worked, how long it took, how many AI calls it made and what they cost. Accounts appear only as a scrambled id, never an email.
- **Admin metrics page** (`/api/admin/metrics`). Admins see speed, errors and AI spend per API route, plus the shared AI budget.
- Tests for the mock AI and the request log.

## [1.7.0] - 2026-10-18

Hosted demo and public waitlist (launch-readiness step 2).

### Added
- **Public demo on Vercel.** Sign up with email and password at https://aidentify-demo.vercel.app. The demo uses Neon Postgres (schema `demo`) and keeps Slack and the board worker on a separate always-on box.
- **Marketing waitlist site.** https://aidentify.vercel.app explains Agents as a Service, who it is for, benefits and features, and lets people join the waitlist. The same form also lives at `/waitlist` and `/early-access` on the demo.
- **Waitlist form fields.** Name, email, business type, city and WhatsApp. Email is required and checked. One row per person: the same email or WhatsApp updates the existing row instead of adding a duplicate. Admins can export CSV from `/api/waitlist?format=csv`.
- **Shared AI with a soft $10 cap.** New demo users can chat right away on a shared OpenRouter key. Soft limits stop the shared pool (total, daily, and per-customer). Staff still count toward the pool.
- **Bring your own AI key (BYOK).** During onboarding or later in the user menu / Settings, paste an OpenRouter, OpenAI, xAI, Google Gemini or Anthropic key. It is checked once, stored encrypted, and never shown again. BYOK users are not limited by the shared pool.
- **Hosted AI docs and tests.** `docs/HOSTED-AI.md` plus automated tests for the key store and waitlist rules.

### Changed
- **Google and email-code sign-in stay hidden** on the hosted demo until OAuth / SMTP are configured. Email + password sign-up stays open.

## [1.6.0] - 2026-10-18

### Changed (please read)
- **AaaS is now proprietary: all rights reserved.** From this version on, nobody may use, copy, change or share the code without written permission from Phanindra Malladi / AaaS. See LICENSE.
- **Earlier versions are not taken back.** Versions up to v1.5.0 were published under the MIT License. If you got one of those versions under MIT, you keep the MIT rights for that version. The new terms apply to v1.6.0 and later.
- **Contributions by invitation only.** Invited contributors sign a written agreement (a contributor licence agreement or a copyright assignment) before their work is merged.
- The README, contribution guide, app settings (About) and app details now say "all rights reserved" instead of MIT.

## [1.5.0] - 2026-10-18

Storage you can host, and an automated test suite. A self-hosted server with no database keeps working exactly as before.

### Changed (please read)
- **Hosted deploys must use Postgres.** With `HOSTED=1`, `NODE_ENV=production` or on Vercel, the server now refuses to start without `DATABASE_URL` and says why. Your own computer or a single server without `DATABASE_URL` still uses `data/kv.json` and prints a note.

### Added
- **Any Postgres, not only Neon.** Neon addresses use Neon's HTTPS driver; other addresses use a connection pool. Brief network errors are retried.
- **No lost updates.** Account changes merge with the latest saved copy, and workspace saves take a short database lock, so two servers writing at the same moment do not overwrite each other. Before this, two sign-ups at the same moment could lose one account.
- **Automatic database setup and upgrades.** Tables, an index for faster lookups and a record of applied upgrades are created on start. `DATABASE_SCHEMA` keeps them in their own schema.
- **Move data between the file and Postgres.** `npm run db:migrate-from-file` (with `--dry-run`; safe to repeat; checks the count and a hash) and `npm run db:export-to-file`.
- **Automated tests,** run on every push: sign-up and login; approval-first for social posts and email (nothing goes out while pending, reject stops it, approve sends it); the browser's pay/buy/submit steps wait for approval; Chief of Staff hands work to the right agent and a group lead turns a goal into board tasks for the right members; saved connector keys are encrypted and never shown back; both storage types. Outside services (AI, Buffer, email) are stand-ins, so tests cost nothing and send nothing.
- **Billing groundwork.** A checker for Razorpay-style signed webhooks, ready for the payments step. Payments themselves are not built yet; that test is marked as skipped.

## [1.4.0] - 2026-10-18

Security basics before launch. Existing servers keep working with no changes: if you already set `ADMIN_PASSWORD`, nothing changes for you.

### Changed (please read)
- **No more default passwords.**
  - The old built-in logins (`admin1234` and `team1234`) no longer exist.
  - On a new server, the first visit opens a short setup screen where you create your own admin password. You need a one-time code shown in the server log, so a stranger who finds the server first cannot take it over.
  - Instead of the setup screen, you can put a strong `ADMIN_PASSWORD` in `.env` before the first start.
  - Weak or common passwords are refused. Staff passwords need at least 12 characters.
  - **If your server still uses an old default password,** that login is now refused. Put a strong `ADMIN_PASSWORD` (or `TEAM_PASSWORD`) in `.env` and restart: the account takes the new password automatically.
- **The demo account needs its own password.** With `DEMO_MODE=1` you must also set `DEMO_USER_PASSWORD`; there is no default demo password any more.
- **New default staff emails.** If you never set `ADMIN_EMAIL` / `TEAM_EMAIL`, new servers now use `admin@aidentify.local` and `team@aidentify.local`. Existing accounts are not touched.
- **The Android app has a new ID (`com.aidentify.app`).** Android treats it as a different app: people with the old app must install the new one and sign in again, and the old one can be removed. The desktop app ID is now `com.aidentify.desktop`. No new app builds come with this release, because the Android and Windows build tools are not set up on the build machine.
- **Installing needs repository access.** The code repository is now private, so the old `curl … | bash` one-liner no longer works. Clone it with the GitHub CLI or SSH, then run `./install.sh`; `npm run update` keeps working from that clone.

### Added
- **Safer remote browser.** The private link to the agents' signed-in browser:
  - closes after 60 minutes at most, even while in use (`REMOTE_BROWSER_MAX_MIN`);
  - can be opened at most 6 times an hour (`REMOTE_BROWSER_OPENS_PER_HOUR`);
  - records every open and close in an audit log.
  - Only you (the Slack owner, a signed-in admin, or your own Chief) can open it. Another account's agents cannot.
- **Security guide.** SECURITY.md explains the remote-browser risks: anyone with the link controls your signed-in accounts; what the ngrok warning page is; how to cut access off. It also has a hardening checklist for going live.
- **Automatic tests** (`npm test`, run on every change) check that:
  - first-run setup is required;
  - default passwords never work;
  - weak passwords are refused;
  - the remote browser cannot be opened without signing in.
- **HANDOFF.md**: one page on what has shipped, what is in progress and what is known to be missing.
- **`npm run social:snapshot`**: a read-only snapshot of X, LinkedIn and Facebook analytics, taken in the agents' browser.

### Fixed
- Leftover "AgentSphere" names were replaced with AaaS. Internal names that existing data depends on (a database table name and two hash prefixes) were kept on purpose so nothing breaks.

## [1.3.0] - 2026-10-17: read-only X, LinkedIn and Facebook analytics snapshot in the agents' browser profile. It writes a dated report, a TSV row and screenshots, and reports signed-out or wrong-account sites instead of guessing.

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
- Rebranded to AaaS across the UI, emails, Slack messages, prompts, docs and app names.
- Slack: DMs are answered asynchronously with an instant :eyes: reaction, missed DMs are answered after a reconnect, and a watchdog forces a reconnect about 60 seconds after a pause or dead socket.
- Goal planning always chains two or more tasks; research tasks get 25 steps; longer model timeout.
- README rewritten for installers and contributors; the previous long README is now `docs/guide.md`.

### Fixed
- Literal `\n` in Slack replies; clearer replies for stale approvals.
- Clean shutdown on SIGTERM.

## [1.1.0] - 2026-10-17

### Added
- Initial AaaS build: web workspace with sign-in (email + password, email code, Google), agents with knowledge bases, Chief of Staff orchestrator, routines, connectors (OAuth, API keys or Composio), Gmail, Buffer social posting, web search, real browser agents, customer share links and live apps, local file or Neon Postgres storage, and Vercel deployment.

[Unreleased]: https://github.com/aidendify/AaaS/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/aidendify/AaaS/releases/tag/v1.4.0
[1.3.0]: https://github.com/aidendify/AaaS/releases/tag/v1.3.0
[1.2.0]: https://github.com/aidendify/AaaS/releases/tag/v1.2.0
[1.1.0]: https://github.com/aidendify/AaaS/commit/b63634d
