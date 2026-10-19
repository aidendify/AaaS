# AIdentify end-to-end scenario report

Written by `npm run e2e`. Each run appends a section below. The findings summary at the top is written by hand.

## Summary (19 Oct 2026; updated for v1.9.0)

- **v1.9.0 on staging:** 4/4 scenarios pass on mock AI and on one real-AI run. Real-AI spend for the v1.9.0 run was about $0.0023.

- **Runs.** The first mock-AI run passed 3 of 4 scenarios: one 500 error (F1). After the fixes the mock-AI run passed 4 of 4, and one real-AI run passed 4 of 4.
- **Real AI spend for the whole job: about $0.0023.** That's 24 shared-key calls on `deepseek/deepseek-v4-flash`, measured from the staging spend log.
- **Mock-AI spend:** $0. The ~$0.0024 of made-up mock cost also sits in the staging spend log.
- **Cleanup:** every throwaway `e2e-…@example.com` account was deleted. A database check afterwards found no test account and no test workspace left in schema `staging`.

| # | Finding | Severity | Evidence | Status / suggested fix |
|---|---|---|---|---|
| F1 | A broken JSON body returned **500** on Vercel instead of a clean 400. Locally it was already 400. | Medium | Run 00:45 IST, scenario d: `HTTP 500 server_error` | **Fixed (v1.8.0).** `api/index.js` catches Vercel's lazy JSON parse error and returns `400 bad_json`. |
| F2 | Deleting an account left its **public link tokens** (`as_tok:<token>` rows) in place. They still held the deleted email and pointed at the deleted account. | Medium (privacy) | After the first run, 2 `as_tok` rows in `staging` still pointed at deleted e2e accounts | **Fixed (v1.8.0).** Account delete (self and admin) now removes them. New test `test/delete-cleanup.test.mjs` fails without the fix. The 2 orphan rows on staging were cleared. The demo schema may have old orphans; it wasn't touched. |
| F3 | `GET /api/kv` reads **every row in the database** (`st.all()`) and then filters to the caller. Every workspace load gets slower as customers are added, and it moves other customers' rows through the function. | High (scale) | `lib/backend.js` `/api/kv` GET handler; ~0.9 s with only a handful of users | **Fixed (v1.9.0).** Customers' `GET /api/kv` reads only their 3 rows in one indexed query. On staging the server-side p50 went from 876 ms to 9 ms (region fix included). Staff views still read everything. |
| F4 | **Fixed overhead per request** is high even with zero-latency mock AI. Each Neon query costs ~100–250 ms and requests run several in sequence. Mock `/api/ai` p50 1.15 s, `PUT /api/kv` 1.6 s, signup 0.75 s, **account delete 4.4 s**. | Medium | `/api/admin/metrics` after the mock run | **Fixed (v1.9.0).** The main cause was the region: functions ran in `iad1` and Neon is in `ap-southeast-1` (~220 ms per query). Functions are now pinned to `sin1`, and requests make fewer, batched queries: one read-ahead for users, AI key and pool, `getMany`/`delMany`, and one-query delete. Server-side p50 on staging, before → after: `/api/ai` (mock) 1099 → 14 ms, account delete 4216 → 72 ms, `/api/auth/me` 438 → 5 ms, signup 714 → 67 ms. |
| F5 | **Real-AI latency is close to Vercel's 60 s limit.** Agent chat p50 20 s, max 30 s. One short `/api/ai` draft took 36.6 s. The public qualify page made the visitor wait 19 s. `LLM_TIMEOUT_MS` defaults to 180 s, longer than the 60 s function limit, so a slow provider ends in a Vercel timeout instead of a clean error. | Medium | Real run 00:59 IST, metrics for that window | **Fixed (v1.9.0) / partly deferred.** On Vercel each AI call gets at most 45 s, and a whole request's AI work must finish within 50 s of the start. Past that, the user gets a clean `504 ai_timeout`, tested. Public lead and qualify pages wait at most 8 s, then use the built-in reply and rule-based score. Real-AI agent chat p50 on staging fell from 20 s to 6 s (max 30 → 10 s). Streaming or async chat is deferred. |
| F6 | A fresh account **can't get any approval** from the agent until it connects an app: `propose_action` needs a connected app, and `send_email` / `social_post` only exist with Gmail / Buffer. Approving an action on a key-based connection (e.g. Trello) **always fails** with "needs Composio", so approved actions on those apps can never run on hosted. | Medium (product) | Scenario a needed a fake Trello connection. The approved item ended `failed` (safe, nothing left the server) | **Fixed (v1.9.0).** New built-in **draft approvals**: with no app connected, posts, replies and emails go to the approval queue. Approving one marks it done and sends nothing; the owner copies it. Proposals for key-only apps (e.g. Trello) also become drafts with a clear message instead of an approval that always fails. Direct Trello actions are deferred. |
| F7 | `POST /api/routines` only accepts a **daily hour:minute**. There's no one-off "follow up in 3 days" through the API, though the agent's own `create_routine` tool supports `first_run`. The test had to wait for the next clock minute. | Low | Scenario b | **Fixed (v1.9.0).** `POST /api/routines` takes `run_at` (ISO) and an optional `repeat_every_days`. One-offs switch off after running. |
| F8 | No hosted scheduler: the routine ran only because the test called `/api/cron/tick` itself. | Known gap, confirmed | Scenario b | **Partly fixed (v1.9.0).** Daily Vercel cron at 08:00 IST in `vercel.json`. Per-minute needs a free outside pinger, documented in `docs/STAGING.md`; none is set up yet (it needs the secret entered in a third-party site). |
| F9 | The shared **spend log keeps deleted accounts' emails** (`as_sys_aipool` days → users). | Known gap, confirmed | 2 e2e emails in the staging pool after the first run | **Fixed (v1.9.0).** On delete the email leaves the spend log. Its usage moves to an anonymous `gone:<hash>` entry, so totals stay correct. |
| F10 | Deletes write `null` **tombstone rows** instead of removing them: 56 already on staging. | Low | Neon count in `staging` | **Fixed (v1.9.0).** Account delete removes rows outright. The 272 old placeholder rows on staging were purged; the demo schema wasn't touched. |
| F11 | There's no business-profile field or signup step. The profile only exists as workspace JSON or agent knowledge, and `/api/ai` never sees it. | Known gap, confirmed | Scenario a note | **Fixed (v1.9.0).** Optional "Your business in one line" at signup, `GET`/`POST /api/profile` for more fields, and the profile goes into every `/api/ai` prompt (opt out with `use_profile:false`), agent chats and routines. Real AI named the business without being told in the prompt. |
| F12 | Rate limits, login throttles and the request metrics are **per server instance** (in memory). On Vercel they reset whenever a new instance starts. | Low / info | `lib/backend.js` `throttle` / `aiGate`, `lib/obs.js` | Phase 2 should measure this under load. Move the counters to Postgres or Upstash if needed. |
| F13 | Out-of-credit and revoked BYOK keys can only be simulated on a mock server, because no real empty key is available. On real AI, only junk and invalid keys were tested. | Info | Scenario c real run | Optional: create a $0-limit OpenRouter test key for one real check. |

What held up well:
- **Approval-first.** Nothing ran before approval. A prompt injection asking to email or post everywhere did nothing, and approvals can't be forged through `PUT /api/kv`.
- **BYOK.** It never fell back to the shared key: per-user and global spend stayed unchanged.
- **Tokens.** Tampered, garbage, logged-out and missing tokens all got 401.
- **Lead flow.** Form → CRM → qualify → routine → cron all worked end to end.

## Run 2026-10-19 00:45 IST · mock AI · staging, Phase 1 first run

Target: https://aidentify-staging.vercel.app. 3/4 scenarios passed.

| Scenario | Result | Checks | Time | AI request p95 | Shared-key AI calls | Shared-key cost |
|---|---|---|---|---|---|---|
| a. Agency owner: profile, 10 drafts, approvals | PASS | 14/14 | 37.2 s | 3.4 s | 12 | $0.00085 (fake) |
| b. Lead flow: quote form → CRM → routine → cron | PASS | 13/13 | 68.8 s | 4.1 s | 3 | $0.00018 (fake) |
| c. Bring your own key: bad keys, no credit, no fallback | PASS | 13/13 | 16.3 s | 1.8 s | 0 | $0.00000 (fake) |
| d. Outside script: login, tasks, token checks | FAIL | 13/14 | 16.0 s | 2.3 s | 4 | $0.00019 (fake) |

<details><summary>a. Agency owner: profile, 10 drafts, approvals: checks</summary>

- ✅ sign up a throwaway account
- ✅ save a business profile (workspace profile + agent knowledge)
- ✅ business profile reads back via GET /api/kv
- ✅ 6 drafts via /api/ai return text (6/6)
- ✅ connect a test app (fake Trello credentials) for approval tests
- ✅ 4 agent chats via /api/workplace/chat answer (4/4)
- ✅ agent proposals become approvals (at least 1 created)
- ✅ nothing auto-executed: every approval is still pending
- ✅ prompt injection did not create an email or social approval (not connected) and nothing was sent
- ✅ approvals cannot be forged through PUT /api/kv
- ✅ reject an approval via API → declined
- ✅ approve an approval via API → runs only now, and with no real Trello/Composio it fails safely
- ✅ deciding an unknown approval → 404
- ✅ account deleted at the end (login refused afterwards)
- note: There is no dedicated business-profile field or signup step: the profile only exists as workspace JSON / agent knowledge (known gap).
- note: 6/6 /api/ai drafts named the business.

</details>

<details><summary>b. Lead flow: quote form → CRM → routine → cron: checks</summary>

- ✅ sign up a throwaway account
- ✅ create a workspace with a lead (quote) form
- ✅ public quote form page opens without sign-in
- ✅ submit the quote form → thank-you page with instant reply and qualify step
- ✅ lead lands in the CRM (read back via GET /api/kv)
- ✅ lead answers the 2 qualifying questions → status qualified with an AI summary
- ✅ create a follow-up routine via POST /api/routines
- ✅ cron tick with a wrong secret → 401
- ✅ routine does not run before its time
- ✅ cron tick runs the due routine and its result lands in the inbox
- ✅ routine is rescheduled for the next day
- ✅ account deleted at the end (login refused afterwards)
- ✅ public lead form stops working once the account is deleted
- note: waiting 43 s for the routine's time (2026-10-18T19:15:00.000Z)

</details>

<details><summary>c. Bring your own key: bad keys, no credit, no fallback: checks</summary>

- ✅ sign up a throwaway account
- ✅ junk key → clean 400 bad_key
- ✅ well-formed but invalid OpenRouter key → clean 400 key_rejected (checked with OpenRouter, not saved)
- ✅ rejected keys are not stored
- ✅ save a (mock) key that has no credit left
- ✅ saved key is never shown back (only the last 4 characters)
- ✅ AI call with an out-of-credit key → clean 400 byok_failed saying out of credit
- ✅ agent chat with an out-of-credit key → clean error, not a 500
- ✅ AI call with a revoked key → clean 400 byok_failed
- ✅ no fallback to the shared key: my shared-key call count is unchanged
- ✅ no fallback to the shared key: the shared spend log is unchanged
- ✅ remove my key → back to the shared key
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>d. Outside script: login, tasks, token checks: checks</summary>

- ✅ sign up a throwaway account
- ✅ log in over the API → token
- ✅ token expires (about 14 days)
- ✅ GET /api/auth/me with the token
- ✅ send 3 tasks and get the results in the same request (3/3)
- ✅ run the full agent from a script
- ✅ no token → 401
- ✅ garbage token → 401
- ✅ tampered token (role changed) → 401
- ✅ bad signature → 401
- ✅ wrong password → 401
- ✅ after logout the old token → 401
- ❌ broken JSON body → clean 4xx, not 500 — HTTP 500 server_error
- ✅ account deleted at the end (login refused afterwards)
- note: acct.token (from signup) was also revoked by logout; the delete step re-logs in.

</details>

## Run 2026-10-19 00:52 IST · mock AI · after fixes

Target: https://aidentify-staging.vercel.app. 4/4 scenarios passed.

| Scenario | Result | Checks | Time | AI request p95 | Shared-key AI calls | Shared-key cost |
|---|---|---|---|---|---|---|
| a. Agency owner: profile, 10 drafts, approvals | PASS | 14/14 | 38.3 s | 3.5 s | 12 | $0.00085 (fake) |
| b. Lead flow: quote form → CRM → routine → cron | PASS | 13/13 | 94.7 s | 4.0 s | 3 | $0.00018 (fake) |
| c. Bring your own key: bad keys, no credit, no fallback | PASS | 13/13 | 15.9 s | 1.7 s | 0 | $0.00000 (fake) |
| d. Outside script: login, tasks, token checks | PASS | 14/14 | 15.7 s | 2.2 s | 4 | $0.00019 (fake) |

<details><summary>a. Agency owner: profile, 10 drafts, approvals: checks</summary>

- ✅ sign up a throwaway account
- ✅ save a business profile (workspace profile + agent knowledge)
- ✅ business profile reads back via GET /api/kv
- ✅ 6 drafts via /api/ai return text (6/6)
- ✅ connect a test app (fake Trello credentials) for approval tests
- ✅ 4 agent chats via /api/workplace/chat answer (4/4)
- ✅ agent proposals become approvals (at least 1 created)
- ✅ nothing auto-executed: every approval is still pending
- ✅ prompt injection did not create an email or social approval (not connected) and nothing was sent
- ✅ approvals cannot be forged through PUT /api/kv
- ✅ reject an approval via API → declined
- ✅ approve an approval via API → runs only now, and with no real Trello/Composio it fails safely
- ✅ deciding an unknown approval → 404
- ✅ account deleted at the end (login refused afterwards)
- note: There is no dedicated business-profile field or signup step: the profile only exists as workspace JSON / agent knowledge (known gap).
- note: 6/6 /api/ai drafts named the business.

</details>

<details><summary>b. Lead flow: quote form → CRM → routine → cron: checks</summary>

- ✅ sign up a throwaway account
- ✅ create a workspace with a lead (quote) form
- ✅ public quote form page opens without sign-in
- ✅ submit the quote form → thank-you page with instant reply and qualify step
- ✅ lead lands in the CRM (read back via GET /api/kv)
- ✅ lead answers the 2 qualifying questions → status qualified with an AI summary
- ✅ create a follow-up routine via POST /api/routines
- ✅ cron tick with a wrong secret → 401
- ✅ routine does not run before its time
- ✅ cron tick runs the due routine and its result lands in the inbox
- ✅ routine is rescheduled for the next day
- ✅ account deleted at the end (login refused afterwards)
- ✅ public lead form stops working once the account is deleted
- note: waiting 69 s for the routine's time (2026-10-18T19:22:00.000Z)

</details>

<details><summary>c. Bring your own key: bad keys, no credit, no fallback: checks</summary>

- ✅ sign up a throwaway account
- ✅ junk key → clean 400 bad_key
- ✅ well-formed but invalid OpenRouter key → clean 400 key_rejected (checked with OpenRouter, not saved)
- ✅ rejected keys are not stored
- ✅ save a (mock) key that has no credit left
- ✅ saved key is never shown back (only the last 4 characters)
- ✅ AI call with an out-of-credit key → clean 400 byok_failed saying out of credit
- ✅ agent chat with an out-of-credit key → clean error, not a 500
- ✅ AI call with a revoked key → clean 400 byok_failed
- ✅ no fallback to the shared key: my shared-key call count is unchanged
- ✅ no fallback to the shared key: the shared spend log is unchanged
- ✅ remove my key → back to the shared key
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>d. Outside script: login, tasks, token checks: checks</summary>

- ✅ sign up a throwaway account
- ✅ log in over the API → token
- ✅ token expires (about 14 days)
- ✅ GET /api/auth/me with the token
- ✅ send 3 tasks and get the results in the same request (3/3)
- ✅ run the full agent from a script
- ✅ no token → 401
- ✅ garbage token → 401
- ✅ tampered token (role changed) → 401
- ✅ bad signature → 401
- ✅ wrong password → 401
- ✅ after logout the old token → 401
- ✅ broken JSON body → clean 4xx, not 500
- ✅ account deleted at the end (login refused afterwards)
- note: acct.token (from signup) was also revoked by logout; the delete step re-logs in.

</details>

## Run 2026-10-19 00:59 IST · real AI · real AI (deepseek/deepseek-v4-flash via OpenRouter)

Target: https://aidentify-staging.vercel.app. 4/4 scenarios passed.

| Scenario | Result | Checks | Time | AI request p95 | Shared-key AI calls | Shared-key cost |
|---|---|---|---|---|---|---|
| a. Agency owner: profile, 10 drafts, approvals | PASS | 14/14 | 194.4 s | 36.6 s | 15 | $0.00146 |
| b. Lead flow: quote form → CRM → routine → cron | PASS | 13/13 | 100.6 s | 19.2 s | 5 | $0.00054 |
| c. Bring your own key: bad keys, no credit, no fallback | PASS | 8/8 | 12.3 s | 0.0 s | 0 | $0.00000 |
| d. Outside script: login, tasks, token checks | PASS | 14/14 | 22.3 s | 4.1 s | 4 | $0.00030 |

<details><summary>a. Agency owner: profile, 10 drafts, approvals: checks</summary>

- ✅ sign up a throwaway account
- ✅ save a business profile (workspace profile + agent knowledge)
- ✅ business profile reads back via GET /api/kv
- ✅ 6 drafts via /api/ai return text (6/6)
- ✅ connect a test app (fake Trello credentials) for approval tests
- ✅ 4 agent chats via /api/workplace/chat answer (4/4)
- ✅ agent proposals become approvals (at least 1 created)
- ✅ nothing auto-executed: every approval is still pending
- ✅ prompt injection did not create an email or social approval (not connected) and nothing was sent
- ✅ approvals cannot be forged through PUT /api/kv
- ✅ reject an approval via API → declined
- ✅ approve an approval via API → runs only now, and with no real Trello/Composio it fails safely
- ✅ deciding an unknown approval → 404
- ✅ account deleted at the end (login refused afterwards)
- note: There is no dedicated business-profile field or signup step: the profile only exists as workspace JSON / agent knowledge (known gap).
- note: 5/6 /api/ai drafts named the business.

</details>

<details><summary>b. Lead flow: quote form → CRM → routine → cron: checks</summary>

- ✅ sign up a throwaway account
- ✅ create a workspace with a lead (quote) form
- ✅ public quote form page opens without sign-in
- ✅ submit the quote form → thank-you page with instant reply and qualify step
- ✅ lead lands in the CRM (read back via GET /api/kv)
- ✅ lead answers the 2 qualifying questions → status qualified with an AI summary
- ✅ create a follow-up routine via POST /api/routines
- ✅ cron tick with a wrong secret → 401
- ✅ routine does not run before its time
- ✅ cron tick runs the due routine and its result lands in the inbox
- ✅ routine is rescheduled for the next day
- ✅ account deleted at the end (login refused afterwards)
- ✅ public lead form stops working once the account is deleted
- note: waiting 44 s for the routine's time (2026-10-18T19:28:00.000Z)

</details>

<details><summary>c. Bring your own key: bad keys, no credit, no fallback: checks</summary>

- ✅ sign up a throwaway account
- ✅ junk key → clean 400 bad_key
- ✅ well-formed but invalid OpenRouter key → clean 400 key_rejected (checked with OpenRouter, not saved)
- ✅ rejected keys are not stored
- ✅ no fallback to the shared key: my shared-key call count is unchanged
- ✅ no fallback to the shared key: the shared spend log is unchanged
- ✅ remove my key → back to the shared key
- ✅ account deleted at the end (login refused afterwards)
- note: Out-of-credit and revoked keys are simulated only on a mock-AI server (no real empty key is available).

</details>

<details><summary>d. Outside script: login, tasks, token checks: checks</summary>

- ✅ sign up a throwaway account
- ✅ log in over the API → token
- ✅ token expires (about 14 days)
- ✅ GET /api/auth/me with the token
- ✅ send 3 tasks and get the results in the same request (3/3)
- ✅ run the full agent from a script
- ✅ no token → 401
- ✅ garbage token → 401
- ✅ tampered token (role changed) → 401
- ✅ bad signature → 401
- ✅ wrong password → 401
- ✅ after logout the old token → 401
- ✅ broken JSON body → clean 4xx, not 500
- ✅ account deleted at the end (login refused afterwards)
- note: acct.token (from signup) was also revoked by logout; the delete step re-logs in.

</details>

## Run 2026-10-19 01:11 IST · mock AI · v1.9.0 fixes

Target: https://aidentify-staging.vercel.app. 4/4 scenarios passed.

| Scenario | Result | Checks | Time | AI request p95 | Shared-key AI calls | Shared-key cost |
|---|---|---|---|---|---|---|
| a. Agency owner: profile, 10 drafts, approvals | PASS | 15/15 | 11.4 s | 0.4 s | 14 | $0.00117 (fake) |
| b. Lead flow: quote form → CRM → routine → cron | PASS | 13/13 | 37.2 s | 0.4 s | 3 | $0.00018 (fake) |
| c. Bring your own key: bad keys, no credit, no fallback | PASS | 13/13 | 5.7 s | 0.3 s | 0 | $0.00000 (fake) |
| d. Outside script: login, tasks, token checks | PASS | 14/14 | 6.2 s | 0.4 s | 4 | $0.00020 (fake) |

<details><summary>a. Agency owner: profile, 10 drafts, approvals: checks</summary>

- ✅ sign up a throwaway account
- ✅ business profile saved at signup (GET /api/profile)
- ✅ save a workspace with a Social Manager agent
- ✅ 6 drafts via /api/ai return text (6/6)
- ✅ drafts use the saved business profile without it being in the prompt (6/6)
- ✅ 4 agent chats via /api/workplace/chat answer (4/4)
- ✅ with NO connected app, posts and replies still land in the approval queue (draft approvals)
- ✅ nothing auto-executed: every approval is still pending
- ✅ prompt injection did not create an email or social send and nothing was sent
- ✅ approvals cannot be forged through PUT /api/kv
- ✅ reject an approval via API → declined
- ✅ approve a draft via API → done, and nothing was sent or posted
- ✅ key-only app (Trello) approval → clear "approved draft, nothing sent" instead of a failure
- ✅ deciding an unknown approval → 404
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>b. Lead flow: quote form → CRM → routine → cron: checks</summary>

- ✅ sign up a throwaway account
- ✅ create a workspace with a lead (quote) form
- ✅ public quote form page opens without sign-in
- ✅ submit the quote form → thank-you page with instant reply and qualify step
- ✅ lead lands in the CRM (read back via GET /api/kv)
- ✅ lead answers the 2 qualifying questions → status qualified with an AI summary
- ✅ create a one-off follow-up routine via POST /api/routines (run_at)
- ✅ cron tick with a wrong secret → 401
- ✅ routine does not run before its time
- ✅ cron tick runs the due routine and its result lands in the inbox
- ✅ one-off routine switches off after it ran (no repeat)
- ✅ account deleted at the end (login refused afterwards)
- ✅ public lead form stops working once the account is deleted
- note: waiting 32 s for the routine's time (2026-10-18T19:41:13.239Z)

</details>

<details><summary>c. Bring your own key: bad keys, no credit, no fallback: checks</summary>

- ✅ sign up a throwaway account
- ✅ junk key → clean 400 bad_key
- ✅ well-formed but invalid OpenRouter key → clean 400 key_rejected (checked with OpenRouter, not saved)
- ✅ rejected keys are not stored
- ✅ save a (mock) key that has no credit left
- ✅ saved key is never shown back (only the last 4 characters)
- ✅ AI call with an out-of-credit key → clean 400 byok_failed saying out of credit
- ✅ agent chat with an out-of-credit key → clean error, not a 500
- ✅ AI call with a revoked key → clean 400 byok_failed
- ✅ no fallback to the shared key: my shared-key call count is unchanged
- ✅ no fallback to the shared key: the shared spend log is unchanged
- ✅ remove my key → back to the shared key
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>d. Outside script: login, tasks, token checks: checks</summary>

- ✅ sign up a throwaway account
- ✅ log in over the API → token
- ✅ token expires (about 14 days)
- ✅ GET /api/auth/me with the token
- ✅ send 3 tasks and get the results in the same request (3/3)
- ✅ run the full agent from a script
- ✅ no token → 401
- ✅ garbage token → 401
- ✅ tampered token (role changed) → 401
- ✅ bad signature → 401
- ✅ wrong password → 401
- ✅ after logout the old token → 401
- ✅ broken JSON body → clean 4xx, not 500
- ✅ account deleted at the end (login refused afterwards)
- note: acct.token (from signup) was also revoked by logout; the delete step re-logs in.

</details>

## Run 2026-10-19 01:15 IST · real AI · v1.9.0 fixes, real AI (deepseek/deepseek-v4-flash)

Target: https://aidentify-staging.vercel.app. 4/4 scenarios passed.

| Scenario | Result | Checks | Time | AI request p95 | Shared-key AI calls | Shared-key cost |
|---|---|---|---|---|---|---|
| a. Agency owner: profile, 10 drafts, approvals | PASS | 15/15 | 75.4 s | 11.5 s | 15 | $0.00149 |
| b. Lead flow: quote form → CRM → routine → cron | PASS | 13/13 | 58.4 s | 13.5 s | 5 | $0.00065 |
| c. Bring your own key: bad keys, no credit, no fallback | PASS | 8/8 | 3.8 s | 0.0 s | 0 | $0.00000 |
| d. Outside script: login, tasks, token checks | PASS | 14/14 | 17.1 s | 4.9 s | 4 | $0.00010 |

<details><summary>a. Agency owner: profile, 10 drafts, approvals: checks</summary>

- ✅ sign up a throwaway account
- ✅ business profile saved at signup (GET /api/profile)
- ✅ save a workspace with a Social Manager agent
- ✅ 6 drafts via /api/ai return text (6/6)
- ✅ drafts use the saved business profile without it being in the prompt (6/6)
- ✅ 4 agent chats via /api/workplace/chat answer (4/4)
- ✅ with NO connected app, posts and replies still land in the approval queue (draft approvals)
- ✅ nothing auto-executed: every approval is still pending
- ✅ prompt injection did not create an email or social send and nothing was sent
- ✅ approvals cannot be forged through PUT /api/kv
- ✅ reject an approval via API → declined
- ✅ approve a draft via API → done, and nothing was sent or posted
- ✅ key-only app (Trello) approval → clear "approved draft, nothing sent" instead of a failure
- ✅ deciding an unknown approval → 404
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>b. Lead flow: quote form → CRM → routine → cron: checks</summary>

- ✅ sign up a throwaway account
- ✅ create a workspace with a lead (quote) form
- ✅ public quote form page opens without sign-in
- ✅ submit the quote form → thank-you page with instant reply and qualify step
- ✅ lead lands in the CRM (read back via GET /api/kv)
- ✅ lead answers the 2 qualifying questions → status qualified with an AI summary
- ✅ create a one-off follow-up routine via POST /api/routines (run_at)
- ✅ cron tick with a wrong secret → 401
- ✅ routine does not run before its time
- ✅ cron tick runs the due routine and its result lands in the inbox
- ✅ one-off routine switches off after it ran (no repeat)
- ✅ account deleted at the end (login refused afterwards)
- ✅ public lead form stops working once the account is deleted
- note: waiting 32 s for the routine's time (2026-10-18T19:44:26.975Z)

</details>

<details><summary>c. Bring your own key: bad keys, no credit, no fallback: checks</summary>

- ✅ sign up a throwaway account
- ✅ junk key → clean 400 bad_key
- ✅ well-formed but invalid OpenRouter key → clean 400 key_rejected (checked with OpenRouter, not saved)
- ✅ rejected keys are not stored
- ✅ no fallback to the shared key: my shared-key call count is unchanged
- ✅ no fallback to the shared key: the shared spend log is unchanged
- ✅ remove my key → back to the shared key
- ✅ account deleted at the end (login refused afterwards)
- note: Out-of-credit and revoked keys are simulated only on a mock-AI server (no real empty key is available).

</details>

<details><summary>d. Outside script: login, tasks, token checks: checks</summary>

- ✅ sign up a throwaway account
- ✅ log in over the API → token
- ✅ token expires (about 14 days)
- ✅ GET /api/auth/me with the token
- ✅ send 3 tasks and get the results in the same request (3/3)
- ✅ run the full agent from a script
- ✅ no token → 401
- ✅ garbage token → 401
- ✅ tampered token (role changed) → 401
- ✅ bad signature → 401
- ✅ wrong password → 401
- ✅ after logout the old token → 401
- ✅ broken JSON body → clean 4xx, not 500
- ✅ account deleted at the end (login refused afterwards)
- note: acct.token (from signup) was also revoked by logout; the delete step re-logs in.

</details>

## Run 2026-10-19 02:18 IST · mock AI · v1.10.0 leads API

Target: https://aidentify-staging.vercel.app. 5/5 scenarios passed.

| Scenario | Result | Checks | Time | AI request p95 | Shared-key AI calls | Shared-key cost |
|---|---|---|---|---|---|---|
| a. Agency owner: profile, 10 drafts, approvals | PASS | 15/15 | 11.2 s | 0.3 s | 14 | $0.00117 (fake) |
| b. Lead flow: quote form → CRM → routine → cron | PASS | 13/13 | 37.6 s | 0.6 s | 3 | $0.00018 (fake) |
| c. Bring your own key: bad keys, no credit, no fallback | PASS | 13/13 | 5.2 s | 0.3 s | 0 | $0.00000 (fake) |
| d. Outside script: login, tasks, token checks | PASS | 14/14 | 6.8 s | 0.3 s | 4 | $0.00019 (fake) |
| e. Single-lead API: add, dedupe, list, change, delete, follow-up | PASS | 13/13 | 5.6 s | 0.0 s | 0 | $0.00000 (fake) |

<details><summary>a. Agency owner: profile, 10 drafts, approvals: checks</summary>

- ✅ sign up a throwaway account
- ✅ business profile saved at signup (GET /api/profile)
- ✅ save a workspace with a Social Manager agent
- ✅ 6 drafts via /api/ai return text (6/6)
- ✅ drafts use the saved business profile without it being in the prompt (6/6)
- ✅ 4 agent chats via /api/workplace/chat answer (4/4)
- ✅ with NO connected app, posts and replies still land in the approval queue (draft approvals)
- ✅ nothing auto-executed: every approval is still pending
- ✅ prompt injection did not create an email or social send and nothing was sent
- ✅ approvals cannot be forged through PUT /api/kv
- ✅ reject an approval via API → declined
- ✅ approve a draft via API → done, and nothing was sent or posted
- ✅ key-only app (Trello) approval → clear "approved draft, nothing sent" instead of a failure
- ✅ deciding an unknown approval → 404
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>b. Lead flow: quote form → CRM → routine → cron: checks</summary>

- ✅ sign up a throwaway account
- ✅ create a workspace with a lead (quote) form
- ✅ public quote form page opens without sign-in
- ✅ submit the quote form → thank-you page with instant reply and qualify step
- ✅ lead lands in the CRM (read back via GET /api/kv)
- ✅ lead answers the 2 qualifying questions → status qualified with an AI summary
- ✅ create a one-off follow-up routine via POST /api/routines (run_at)
- ✅ cron tick with a wrong secret → 401
- ✅ routine does not run before its time
- ✅ cron tick runs the due routine and its result lands in the inbox
- ✅ one-off routine switches off after it ran (no repeat)
- ✅ account deleted at the end (login refused afterwards)
- ✅ public lead form stops working once the account is deleted
- note: waiting 32 s for the routine's time (2026-10-18T20:47:42.096Z)

</details>

<details><summary>c. Bring your own key: bad keys, no credit, no fallback: checks</summary>

- ✅ sign up a throwaway account
- ✅ junk key → clean 400 bad_key
- ✅ well-formed but invalid OpenRouter key → clean 400 key_rejected (checked with OpenRouter, not saved)
- ✅ rejected keys are not stored
- ✅ save a (mock) key that has no credit left
- ✅ saved key is never shown back (only the last 4 characters)
- ✅ AI call with an out-of-credit key → clean 400 byok_failed saying out of credit
- ✅ agent chat with an out-of-credit key → clean error, not a 500
- ✅ AI call with a revoked key → clean 400 byok_failed
- ✅ no fallback to the shared key: my shared-key call count is unchanged
- ✅ no fallback to the shared key: the shared spend log is unchanged
- ✅ remove my key → back to the shared key
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>d. Outside script: login, tasks, token checks: checks</summary>

- ✅ sign up a throwaway account
- ✅ log in over the API → token
- ✅ token expires (about 14 days)
- ✅ GET /api/auth/me with the token
- ✅ send 3 tasks and get the results in the same request (3/3)
- ✅ run the full agent from a script
- ✅ no token → 401
- ✅ garbage token → 401
- ✅ tampered token (role changed) → 401
- ✅ bad signature → 401
- ✅ wrong password → 401
- ✅ after logout the old token → 401
- ✅ broken JSON body → clean 4xx, not 500
- ✅ account deleted at the end (login refused afterwards)
- note: acct.token (from signup) was also revoked by logout; the delete step re-logs in.

</details>

<details><summary>e. Single-lead API: add, dedupe, list, change, delete, follow-up: checks</summary>

- ✅ sign up a throwaway account
- ✅ invalid lead → 400 bad_lead
- ✅ POST /api/leads creates a lead with an id
- ✅ followUp creates a one-off routine ~3 days out
- ✅ same email → 409 duplicate with the existing lead
- ✅ 8 concurrent POSTs all succeed with distinct ids (no lost writes on Neon)
- ✅ GET /api/leads lists all 9
- ✅ filters and limit work
- ✅ leads appear in the workspace CRM the web app reads (GET /api/kv)
- ✅ PATCH changes status and score
- ✅ DELETE removes the lead (then 404)
- ✅ writing leads sent nothing and queued no approvals
- ✅ account deleted at the end (login refused afterwards)

</details>

## Run 2026-10-20 00:16 IST · mock AI · v1.11.0 mock AI

Target: https://aidentify-staging.vercel.app. 6/6 scenarios passed.

| Scenario | Result | Checks | Time | AI request p95 | Shared-key AI calls | Shared-key cost |
|---|---|---|---|---|---|---|
| a. Agency owner: profile, 10 drafts, approvals | PASS | 15/15 | 11.7 s | 0.4 s | 14 | $0.00117 (fake) |
| b. Lead flow: quote form → CRM → routine → cron | PASS | 13/13 | 37.3 s | 0.4 s | 3 | $0.00018 (fake) |
| c. Bring your own key: bad keys, no credit, no fallback | PASS | 13/13 | 5.0 s | 0.3 s | 0 | $0.00000 (fake) |
| d. Outside script: login, tasks, token checks | PASS | 14/14 | 6.2 s | 0.3 s | 4 | $0.00019 (fake) |
| e. Single-lead API: add, dedupe, list, change, delete, follow-up | PASS | 13/13 | 5.1 s | 0.0 s | 0 | $0.00000 (fake) |
| f. Sign-in: password rules, reset link, old password refused | PASS | 12/12 | 4.0 s | 0.0 s | 0 | $0.00000 (fake) |

<details><summary>a. Agency owner: profile, 10 drafts, approvals: checks</summary>

- ✅ sign up a throwaway account
- ✅ business profile saved at signup (GET /api/profile)
- ✅ save a workspace with a Social Manager agent
- ✅ 6 drafts via /api/ai return text (6/6)
- ✅ drafts use the saved business profile without it being in the prompt (6/6)
- ✅ 4 agent chats via /api/workplace/chat answer (4/4)
- ✅ with NO connected app, posts and replies still land in the approval queue (draft approvals)
- ✅ nothing auto-executed: every approval is still pending
- ✅ prompt injection did not create an email or social send and nothing was sent
- ✅ approvals cannot be forged through PUT /api/kv
- ✅ reject an approval via API → declined
- ✅ approve a draft via API → done, and nothing was sent or posted
- ✅ key-only app (Trello) approval → clear "approved draft, nothing sent" instead of a failure
- ✅ deciding an unknown approval → 404
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>b. Lead flow: quote form → CRM → routine → cron: checks</summary>

- ✅ sign up a throwaway account
- ✅ create a workspace with a lead (quote) form
- ✅ public quote form page opens without sign-in
- ✅ submit the quote form → thank-you page with instant reply and qualify step
- ✅ lead lands in the CRM (read back via GET /api/kv)
- ✅ lead answers the 2 qualifying questions → status qualified with an AI summary
- ✅ create a one-off follow-up routine via POST /api/routines (run_at)
- ✅ cron tick with a wrong secret → 401
- ✅ routine does not run before its time
- ✅ cron tick runs the due routine and its result lands in the inbox
- ✅ one-off routine switches off after it ran (no repeat)
- ✅ account deleted at the end (login refused afterwards)
- ✅ public lead form stops working once the account is deleted
- note: waiting 32 s for the routine's time (2026-10-19T18:46:25.004Z)

</details>

<details><summary>c. Bring your own key: bad keys, no credit, no fallback: checks</summary>

- ✅ sign up a throwaway account
- ✅ junk key → clean 400 bad_key
- ✅ well-formed but invalid OpenRouter key → clean 400 key_rejected (checked with OpenRouter, not saved)
- ✅ rejected keys are not stored
- ✅ save a (mock) key that has no credit left
- ✅ saved key is never shown back (only the last 4 characters)
- ✅ AI call with an out-of-credit key → clean 400 byok_failed saying out of credit
- ✅ agent chat with an out-of-credit key → clean error, not a 500
- ✅ AI call with a revoked key → clean 400 byok_failed
- ✅ no fallback to the shared key: my shared-key call count is unchanged
- ✅ no fallback to the shared key: the shared spend log is unchanged
- ✅ remove my key → back to the shared key
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>d. Outside script: login, tasks, token checks: checks</summary>

- ✅ sign up a throwaway account
- ✅ log in over the API → token
- ✅ token expires (about 14 days)
- ✅ GET /api/auth/me with the token
- ✅ send 3 tasks and get the results in the same request (3/3)
- ✅ run the full agent from a script
- ✅ no token → 401
- ✅ garbage token → 401
- ✅ tampered token (role changed) → 401
- ✅ bad signature → 401
- ✅ wrong password → 401
- ✅ after logout the old token → 401
- ✅ broken JSON body → clean 4xx, not 500
- ✅ account deleted at the end (login refused afterwards)
- note: acct.token (from signup) was also revoked by logout; the delete step re-logs in.

</details>

<details><summary>e. Single-lead API: add, dedupe, list, change, delete, follow-up: checks</summary>

- ✅ sign up a throwaway account
- ✅ invalid lead → 400 bad_lead
- ✅ POST /api/leads creates a lead with an id
- ✅ followUp creates a one-off routine ~3 days out
- ✅ same email → 409 duplicate with the existing lead
- ✅ 8 concurrent POSTs all succeed with distinct ids (no lost writes on Neon)
- ✅ GET /api/leads lists all 9
- ✅ filters and limit work
- ✅ leads appear in the workspace CRM the web app reads (GET /api/kv)
- ✅ PATCH changes status and score
- ✅ DELETE removes the lead (then 404)
- ✅ writing leads sent nothing and queued no approvals
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>f. Sign-in: password rules, reset link, old password refused: checks</summary>

- ✅ sign up with a weak password is refused with a clear reason
- ✅ sign up with a strong password works
- ✅ reset request answers the same for known and unknown emails
- ✅ mock server gives the e2e test hook a reset token
- ✅ new password must follow the rules too
- ✅ set a new password with the reset link
- ✅ the reset link works only once
- ✅ old password no longer works
- ✅ sessions from before the reset are signed out
- ✅ new password signs in
- ✅ /signup sends people to the one sign-in screen
- ✅ account deleted at the end
- note: mail sender on this server: off

</details>

## Run 2026-10-20 00:25 IST · mock AI

Target: https://aidentify-staging.vercel.app. 6/6 scenarios passed.

| Scenario | Result | Checks | Time | AI request p95 | Shared-key AI calls | Shared-key cost |
|---|---|---|---|---|---|---|
| a. Agency owner: profile, 10 drafts, approvals | PASS | 15/15 | 11.2 s | 0.4 s | 14 | $0.00117 (fake) |
| b. Lead flow: quote form → CRM → routine → cron | PASS | 13/13 | 37.2 s | 0.4 s | 3 | $0.00018 (fake) |
| c. Bring your own key: bad keys, no credit, no fallback | PASS | 13/13 | 5.2 s | 0.3 s | 0 | $0.00000 (fake) |
| d. Outside script: login, tasks, token checks | PASS | 14/14 | 6.2 s | 0.3 s | 4 | $0.00019 (fake) |
| e. Single-lead API: add, dedupe, list, change, delete, follow-up | PASS | 13/13 | 5.0 s | 0.0 s | 0 | $0.00000 (fake) |
| f. Sign-in: password rules, reset link, old password refused | PASS | 12/12 | 3.9 s | 0.0 s | 0 | $0.00000 (fake) |

<details><summary>a. Agency owner: profile, 10 drafts, approvals: checks</summary>

- ✅ sign up a throwaway account
- ✅ business profile saved at signup (GET /api/profile)
- ✅ save a workspace with a Social Manager agent
- ✅ 6 drafts via /api/ai return text (6/6)
- ✅ drafts use the saved business profile without it being in the prompt (6/6)
- ✅ 4 agent chats via /api/workplace/chat answer (4/4)
- ✅ with NO connected app, posts and replies still land in the approval queue (draft approvals)
- ✅ nothing auto-executed: every approval is still pending
- ✅ prompt injection did not create an email or social send and nothing was sent
- ✅ approvals cannot be forged through PUT /api/kv
- ✅ reject an approval via API → declined
- ✅ approve a draft via API → done, and nothing was sent or posted
- ✅ key-only app (Trello) approval → clear "approved draft, nothing sent" instead of a failure
- ✅ deciding an unknown approval → 404
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>b. Lead flow: quote form → CRM → routine → cron: checks</summary>

- ✅ sign up a throwaway account
- ✅ create a workspace with a lead (quote) form
- ✅ public quote form page opens without sign-in
- ✅ submit the quote form → thank-you page with instant reply and qualify step
- ✅ lead lands in the CRM (read back via GET /api/kv)
- ✅ lead answers the 2 qualifying questions → status qualified with an AI summary
- ✅ create a one-off follow-up routine via POST /api/routines (run_at)
- ✅ cron tick with a wrong secret → 401
- ✅ routine does not run before its time
- ✅ cron tick runs the due routine and its result lands in the inbox
- ✅ one-off routine switches off after it ran (no repeat)
- ✅ account deleted at the end (login refused afterwards)
- ✅ public lead form stops working once the account is deleted
- note: waiting 32 s for the routine's time (2026-10-19T18:55:33.303Z)

</details>

<details><summary>c. Bring your own key: bad keys, no credit, no fallback: checks</summary>

- ✅ sign up a throwaway account
- ✅ junk key → clean 400 bad_key
- ✅ well-formed but invalid OpenRouter key → clean 400 key_rejected (checked with OpenRouter, not saved)
- ✅ rejected keys are not stored
- ✅ save a (mock) key that has no credit left
- ✅ saved key is never shown back (only the last 4 characters)
- ✅ AI call with an out-of-credit key → clean 400 byok_failed saying out of credit
- ✅ agent chat with an out-of-credit key → clean error, not a 500
- ✅ AI call with a revoked key → clean 400 byok_failed
- ✅ no fallback to the shared key: my shared-key call count is unchanged
- ✅ no fallback to the shared key: the shared spend log is unchanged
- ✅ remove my key → back to the shared key
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>d. Outside script: login, tasks, token checks: checks</summary>

- ✅ sign up a throwaway account
- ✅ log in over the API → token
- ✅ token expires (about 14 days)
- ✅ GET /api/auth/me with the token
- ✅ send 3 tasks and get the results in the same request (3/3)
- ✅ run the full agent from a script
- ✅ no token → 401
- ✅ garbage token → 401
- ✅ tampered token (role changed) → 401
- ✅ bad signature → 401
- ✅ wrong password → 401
- ✅ after logout the old token → 401
- ✅ broken JSON body → clean 4xx, not 500
- ✅ account deleted at the end (login refused afterwards)
- note: acct.token (from signup) was also revoked by logout; the delete step re-logs in.

</details>

<details><summary>e. Single-lead API: add, dedupe, list, change, delete, follow-up: checks</summary>

- ✅ sign up a throwaway account
- ✅ invalid lead → 400 bad_lead
- ✅ POST /api/leads creates a lead with an id
- ✅ followUp creates a one-off routine ~3 days out
- ✅ same email → 409 duplicate with the existing lead
- ✅ 8 concurrent POSTs all succeed with distinct ids (no lost writes on Neon)
- ✅ GET /api/leads lists all 9
- ✅ filters and limit work
- ✅ leads appear in the workspace CRM the web app reads (GET /api/kv)
- ✅ PATCH changes status and score
- ✅ DELETE removes the lead (then 404)
- ✅ writing leads sent nothing and queued no approvals
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>f. Sign-in: password rules, reset link, old password refused: checks</summary>

- ✅ sign up with a weak password is refused with a clear reason
- ✅ sign up with a strong password works
- ✅ reset request answers the same for known and unknown emails
- ✅ mock server gives the e2e test hook a reset token
- ✅ new password must follow the rules too
- ✅ set a new password with the reset link
- ✅ the reset link works only once
- ✅ old password no longer works
- ✅ sessions from before the reset are signed out
- ✅ new password signs in
- ✅ /signup sends people to the one sign-in screen
- ✅ account deleted at the end
- note: mail sender on this server: off

</details>

## Run 2026-10-20 00:32 IST · mock AI

Target: https://aidentify-staging.vercel.app. 6/6 scenarios passed.

| Scenario | Result | Checks | Time | AI request p95 | Shared-key AI calls | Shared-key cost |
|---|---|---|---|---|---|---|
| a. Agency owner: profile, 10 drafts, approvals | PASS | 15/15 | 11.4 s | 0.3 s | 14 | $0.00117 (fake) |
| b. Lead flow: quote form → CRM → routine → cron | PASS | 13/13 | 37.8 s | 0.5 s | 3 | $0.00018 (fake) |
| c. Bring your own key: bad keys, no credit, no fallback | PASS | 13/13 | 14.5 s | 0.3 s | 0 | $0.00000 (fake) |
| d. Outside script: login, tasks, token checks | PASS | 14/14 | 6.6 s | 0.5 s | 4 | $0.00019 (fake) |
| e. Single-lead API: add, dedupe, list, change, delete, follow-up | PASS | 13/13 | 4.4 s | 0.0 s | 0 | $0.00000 (fake) |
| f. Sign-in: password rules, reset link, old password refused | PASS | 12/12 | 3.8 s | 0.0 s | 0 | $0.00000 (fake) |

<details><summary>a. Agency owner: profile, 10 drafts, approvals: checks</summary>

- ✅ sign up a throwaway account
- ✅ business profile saved at signup (GET /api/profile)
- ✅ save a workspace with a Social Manager agent
- ✅ 6 drafts via /api/ai return text (6/6)
- ✅ drafts use the saved business profile without it being in the prompt (6/6)
- ✅ 4 agent chats via /api/workplace/chat answer (4/4)
- ✅ with NO connected app, posts and replies still land in the approval queue (draft approvals)
- ✅ nothing auto-executed: every approval is still pending
- ✅ prompt injection did not create an email or social send and nothing was sent
- ✅ approvals cannot be forged through PUT /api/kv
- ✅ reject an approval via API → declined
- ✅ approve a draft via API → done, and nothing was sent or posted
- ✅ key-only app (Trello) approval → clear "approved draft, nothing sent" instead of a failure
- ✅ deciding an unknown approval → 404
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>b. Lead flow: quote form → CRM → routine → cron: checks</summary>

- ✅ sign up a throwaway account
- ✅ create a workspace with a lead (quote) form
- ✅ public quote form page opens without sign-in
- ✅ submit the quote form → thank-you page with instant reply and qualify step
- ✅ lead lands in the CRM (read back via GET /api/kv)
- ✅ lead answers the 2 qualifying questions → status qualified with an AI summary
- ✅ create a one-off follow-up routine via POST /api/routines (run_at)
- ✅ cron tick with a wrong secret → 401
- ✅ routine does not run before its time
- ✅ cron tick runs the due routine and its result lands in the inbox
- ✅ one-off routine switches off after it ran (no repeat)
- ✅ account deleted at the end (login refused afterwards)
- ✅ public lead form stops working once the account is deleted
- note: waiting 32 s for the routine's time (2026-10-19T19:01:44.409Z)

</details>

<details><summary>c. Bring your own key: bad keys, no credit, no fallback: checks</summary>

- ✅ sign up a throwaway account
- ✅ junk key → clean 400 bad_key
- ✅ well-formed but invalid OpenRouter key → clean 400 key_rejected (checked with OpenRouter, not saved)
- ✅ rejected keys are not stored
- ✅ save a (mock) key that has no credit left
- ✅ saved key is never shown back (only the last 4 characters)
- ✅ AI call with an out-of-credit key → clean 400 byok_failed saying out of credit
- ✅ agent chat with an out-of-credit key → clean error, not a 500
- ✅ AI call with a revoked key → clean 400 byok_failed
- ✅ no fallback to the shared key: my shared-key call count is unchanged
- ✅ no fallback to the shared key: the shared spend log is unchanged
- ✅ remove my key → back to the shared key
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>d. Outside script: login, tasks, token checks: checks</summary>

- ✅ sign up a throwaway account
- ✅ log in over the API → token
- ✅ token expires (about 14 days)
- ✅ GET /api/auth/me with the token
- ✅ send 3 tasks and get the results in the same request (3/3)
- ✅ run the full agent from a script
- ✅ no token → 401
- ✅ garbage token → 401
- ✅ tampered token (role changed) → 401
- ✅ bad signature → 401
- ✅ wrong password → 401
- ✅ after logout the old token → 401
- ✅ broken JSON body → clean 4xx, not 500
- ✅ account deleted at the end (login refused afterwards)
- note: acct.token (from signup) was also revoked by logout; the delete step re-logs in.

</details>

<details><summary>e. Single-lead API: add, dedupe, list, change, delete, follow-up: checks</summary>

- ✅ sign up a throwaway account
- ✅ invalid lead → 400 bad_lead
- ✅ POST /api/leads creates a lead with an id
- ✅ followUp creates a one-off routine ~3 days out
- ✅ same email → 409 duplicate with the existing lead
- ✅ 8 concurrent POSTs all succeed with distinct ids (no lost writes on Neon)
- ✅ GET /api/leads lists all 9
- ✅ filters and limit work
- ✅ leads appear in the workspace CRM the web app reads (GET /api/kv)
- ✅ PATCH changes status and score
- ✅ DELETE removes the lead (then 404)
- ✅ writing leads sent nothing and queued no approvals
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>f. Sign-in: password rules, reset link, old password refused: checks</summary>

- ✅ sign up with a weak password is refused with a clear reason
- ✅ sign up with a strong password works
- ✅ reset request answers the same for known and unknown emails
- ✅ mock server gives the e2e test hook a reset token
- ✅ new password must follow the rules too
- ✅ set a new password with the reset link
- ✅ the reset link works only once
- ✅ old password no longer works
- ✅ sessions from before the reset are signed out
- ✅ new password signs in
- ✅ /signup sends people to the one sign-in screen
- ✅ account deleted at the end
- note: mail sender on this server: off

</details>

## Run 2026-10-20 00:39 IST · mock AI

Target: https://aidentify-staging.vercel.app. 6/6 scenarios passed.

| Scenario | Result | Checks | Time | AI request p95 | Shared-key AI calls | Shared-key cost |
|---|---|---|---|---|---|---|
| a. Agency owner: profile, 10 drafts, approvals | PASS | 15/15 | 11.5 s | 0.5 s | 14 | $0.00117 (fake) |
| b. Lead flow: quote form → CRM → routine → cron | PASS | 13/13 | 37.2 s | 0.4 s | 3 | $0.00018 (fake) |
| c. Bring your own key: bad keys, no credit, no fallback | PASS | 13/13 | 5.4 s | 0.4 s | 0 | $0.00000 (fake) |
| d. Outside script: login, tasks, token checks | PASS | 14/14 | 6.2 s | 0.3 s | 4 | $0.00020 (fake) |
| e. Single-lead API: add, dedupe, list, change, delete, follow-up | PASS | 13/13 | 5.0 s | 0.0 s | 0 | $0.00000 (fake) |
| f. Sign-in: password rules, reset link, old password refused | PASS | 12/12 | 3.7 s | 0.0 s | 0 | $0.00000 (fake) |

<details><summary>a. Agency owner: profile, 10 drafts, approvals: checks</summary>

- ✅ sign up a throwaway account
- ✅ business profile saved at signup (GET /api/profile)
- ✅ save a workspace with a Social Manager agent
- ✅ 6 drafts via /api/ai return text (6/6)
- ✅ drafts use the saved business profile without it being in the prompt (6/6)
- ✅ 4 agent chats via /api/workplace/chat answer (4/4)
- ✅ with NO connected app, posts and replies still land in the approval queue (draft approvals)
- ✅ nothing auto-executed: every approval is still pending
- ✅ prompt injection did not create an email or social send and nothing was sent
- ✅ approvals cannot be forged through PUT /api/kv
- ✅ reject an approval via API → declined
- ✅ approve a draft via API → done, and nothing was sent or posted
- ✅ key-only app (Trello) approval → clear "approved draft, nothing sent" instead of a failure
- ✅ deciding an unknown approval → 404
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>b. Lead flow: quote form → CRM → routine → cron: checks</summary>

- ✅ sign up a throwaway account
- ✅ create a workspace with a lead (quote) form
- ✅ public quote form page opens without sign-in
- ✅ submit the quote form → thank-you page with instant reply and qualify step
- ✅ lead lands in the CRM (read back via GET /api/kv)
- ✅ lead answers the 2 qualifying questions → status qualified with an AI summary
- ✅ create a one-off follow-up routine via POST /api/routines (run_at)
- ✅ cron tick with a wrong secret → 401
- ✅ routine does not run before its time
- ✅ cron tick runs the due routine and its result lands in the inbox
- ✅ one-off routine switches off after it ran (no repeat)
- ✅ account deleted at the end (login refused afterwards)
- ✅ public lead form stops working once the account is deleted
- note: waiting 32 s for the routine's time (2026-10-19T19:09:07.036Z)

</details>

<details><summary>c. Bring your own key: bad keys, no credit, no fallback: checks</summary>

- ✅ sign up a throwaway account
- ✅ junk key → clean 400 bad_key
- ✅ well-formed but invalid OpenRouter key → clean 400 key_rejected (checked with OpenRouter, not saved)
- ✅ rejected keys are not stored
- ✅ save a (mock) key that has no credit left
- ✅ saved key is never shown back (only the last 4 characters)
- ✅ AI call with an out-of-credit key → clean 400 byok_failed saying out of credit
- ✅ agent chat with an out-of-credit key → clean error, not a 500
- ✅ AI call with a revoked key → clean 400 byok_failed
- ✅ no fallback to the shared key: my shared-key call count is unchanged
- ✅ no fallback to the shared key: the shared spend log is unchanged
- ✅ remove my key → back to the shared key
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>d. Outside script: login, tasks, token checks: checks</summary>

- ✅ sign up a throwaway account
- ✅ log in over the API → token
- ✅ token expires (about 14 days)
- ✅ GET /api/auth/me with the token
- ✅ send 3 tasks and get the results in the same request (3/3)
- ✅ run the full agent from a script
- ✅ no token → 401
- ✅ garbage token → 401
- ✅ tampered token (role changed) → 401
- ✅ bad signature → 401
- ✅ wrong password → 401
- ✅ after logout the old token → 401
- ✅ broken JSON body → clean 4xx, not 500
- ✅ account deleted at the end (login refused afterwards)
- note: acct.token (from signup) was also revoked by logout; the delete step re-logs in.

</details>

<details><summary>e. Single-lead API: add, dedupe, list, change, delete, follow-up: checks</summary>

- ✅ sign up a throwaway account
- ✅ invalid lead → 400 bad_lead
- ✅ POST /api/leads creates a lead with an id
- ✅ followUp creates a one-off routine ~3 days out
- ✅ same email → 409 duplicate with the existing lead
- ✅ 8 concurrent POSTs all succeed with distinct ids (no lost writes on Neon)
- ✅ GET /api/leads lists all 9
- ✅ filters and limit work
- ✅ leads appear in the workspace CRM the web app reads (GET /api/kv)
- ✅ PATCH changes status and score
- ✅ DELETE removes the lead (then 404)
- ✅ writing leads sent nothing and queued no approvals
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>f. Sign-in: password rules, reset link, old password refused: checks</summary>

- ✅ sign up with a weak password is refused with a clear reason
- ✅ sign up with a strong password works
- ✅ reset request answers the same for known and unknown emails
- ✅ mock server gives the e2e test hook a reset token
- ✅ new password must follow the rules too
- ✅ set a new password with the reset link
- ✅ the reset link works only once
- ✅ old password no longer works
- ✅ sessions from before the reset are signed out
- ✅ new password signs in
- ✅ /signup sends people to the one sign-in screen
- ✅ account deleted at the end
- note: mail sender on this server: off

</details>

## Run 2026-10-20 00:57 IST · mock AI

Target: https://aidentify-staging.vercel.app. 7/7 scenarios passed.

| Scenario | Result | Checks | Time | AI request p95 | Shared-key AI calls | Shared-key cost |
|---|---|---|---|---|---|---|
| a. Agency owner: profile, 10 drafts, approvals | PASS | 15/15 | 11.6 s | 0.5 s | 14 | $0.00117 (fake) |
| b. Lead flow: quote form → CRM → routine → cron | PASS | 13/13 | 37.2 s | 0.4 s | 3 | $0.00018 (fake) |
| c. Bring your own key: bad keys, no credit, no fallback | PASS | 13/13 | 5.6 s | 0.3 s | 0 | $0.00000 (fake) |
| d. Outside script: login, tasks, token checks | PASS | 14/14 | 6.1 s | 0.3 s | 4 | $0.00020 (fake) |
| e. Single-lead API: add, dedupe, list, change, delete, follow-up | PASS | 13/13 | 5.0 s | 0.0 s | 0 | $0.00000 (fake) |
| f. Sign-in: password rules, reset link, old password refused | PASS | 12/12 | 4.0 s | 0.0 s | 0 | $0.00000 (fake) |
| g. Integrations: connections, CRM fields/stages/CSV/tags, approvals edit/batch/history | PASS | 18/18 | 7.9 s | 0.0 s | 6 | $0.00069 (fake) |

<details><summary>a. Agency owner: profile, 10 drafts, approvals: checks</summary>

- ✅ sign up a throwaway account
- ✅ business profile saved at signup (GET /api/profile)
- ✅ save a workspace with a Social Manager agent
- ✅ 6 drafts via /api/ai return text (6/6)
- ✅ drafts use the saved business profile without it being in the prompt (6/6)
- ✅ 4 agent chats via /api/workplace/chat answer (4/4)
- ✅ with NO connected app, posts and replies still land in the approval queue (draft approvals)
- ✅ nothing auto-executed: every approval is still pending
- ✅ prompt injection did not create an email or social send and nothing was sent
- ✅ approvals cannot be forged through PUT /api/kv
- ✅ reject an approval via API → declined
- ✅ approve a draft via API → done, and nothing was sent or posted
- ✅ key-only app (Trello) approval → clear "approved draft, nothing sent" instead of a failure
- ✅ deciding an unknown approval → 404
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>b. Lead flow: quote form → CRM → routine → cron: checks</summary>

- ✅ sign up a throwaway account
- ✅ create a workspace with a lead (quote) form
- ✅ public quote form page opens without sign-in
- ✅ submit the quote form → thank-you page with instant reply and qualify step
- ✅ lead lands in the CRM (read back via GET /api/kv)
- ✅ lead answers the 2 qualifying questions → status qualified with an AI summary
- ✅ create a one-off follow-up routine via POST /api/routines (run_at)
- ✅ cron tick with a wrong secret → 401
- ✅ routine does not run before its time
- ✅ cron tick runs the due routine and its result lands in the inbox
- ✅ one-off routine switches off after it ran (no repeat)
- ✅ account deleted at the end (login refused afterwards)
- ✅ public lead form stops working once the account is deleted
- note: waiting 32 s for the routine's time (2026-10-19T19:26:52.309Z)

</details>

<details><summary>c. Bring your own key: bad keys, no credit, no fallback: checks</summary>

- ✅ sign up a throwaway account
- ✅ junk key → clean 400 bad_key
- ✅ well-formed but invalid OpenRouter key → clean 400 key_rejected (checked with OpenRouter, not saved)
- ✅ rejected keys are not stored
- ✅ save a (mock) key that has no credit left
- ✅ saved key is never shown back (only the last 4 characters)
- ✅ AI call with an out-of-credit key → clean 400 byok_failed saying out of credit
- ✅ agent chat with an out-of-credit key → clean error, not a 500
- ✅ AI call with a revoked key → clean 400 byok_failed
- ✅ no fallback to the shared key: my shared-key call count is unchanged
- ✅ no fallback to the shared key: the shared spend log is unchanged
- ✅ remove my key → back to the shared key
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>d. Outside script: login, tasks, token checks: checks</summary>

- ✅ sign up a throwaway account
- ✅ log in over the API → token
- ✅ token expires (about 14 days)
- ✅ GET /api/auth/me with the token
- ✅ send 3 tasks and get the results in the same request (3/3)
- ✅ run the full agent from a script
- ✅ no token → 401
- ✅ garbage token → 401
- ✅ tampered token (role changed) → 401
- ✅ bad signature → 401
- ✅ wrong password → 401
- ✅ after logout the old token → 401
- ✅ broken JSON body → clean 4xx, not 500
- ✅ account deleted at the end (login refused afterwards)
- note: acct.token (from signup) was also revoked by logout; the delete step re-logs in.

</details>

<details><summary>e. Single-lead API: add, dedupe, list, change, delete, follow-up: checks</summary>

- ✅ sign up a throwaway account
- ✅ invalid lead → 400 bad_lead
- ✅ POST /api/leads creates a lead with an id
- ✅ followUp creates a one-off routine ~3 days out
- ✅ same email → 409 duplicate with the existing lead
- ✅ 8 concurrent POSTs all succeed with distinct ids (no lost writes on Neon)
- ✅ GET /api/leads lists all 9
- ✅ filters and limit work
- ✅ leads appear in the workspace CRM the web app reads (GET /api/kv)
- ✅ PATCH changes status and score
- ✅ DELETE removes the lead (then 404)
- ✅ writing leads sent nothing and queued no approvals
- ✅ account deleted at the end (login refused afterwards)

</details>

<details><summary>f. Sign-in: password rules, reset link, old password refused: checks</summary>

- ✅ sign up with a weak password is refused with a clear reason
- ✅ sign up with a strong password works
- ✅ reset request answers the same for known and unknown emails
- ✅ mock server gives the e2e test hook a reset token
- ✅ new password must follow the rules too
- ✅ set a new password with the reset link
- ✅ the reset link works only once
- ✅ old password no longer works
- ✅ sessions from before the reset are signed out
- ✅ new password signs in
- ✅ /signup sends people to the one sign-in screen
- ✅ account deleted at the end
- note: mail sender on this server: off

</details>

<details><summary>g. Integrations: connections, CRM fields/stages/CSV/tags, approvals edit/batch/history: checks</summary>

- ✅ sign up a throwaway account
- ✅ sign up a throwaway account
- ✅ connections list answers with no apps connected
- ✅ checking an app that is not connected says so (404)
- ✅ disconnecting an app that is not connected reports was:false
- ✅ custom fields and stages saved
- ✅ CSV dry run: 2 new, 1 problem, nothing saved
- ✅ CSV import saved 2 leads with fields and tags
- ✅ bulk tags work for the owner, change nothing for another account
- ✅ CSV export downloads the leads
- ✅ another account exports none of them
- ✅ three draft approvals waiting
- ✅ edit works for the owner, 404 for another account
- ✅ reject with a note, then batch approve two (drafts: nothing sent)
- ✅ history shows 3 decided, 0 waiting
- ✅ clear history removes the decided items
- ✅ account deleted at the end (login refused afterwards)
- ✅ account deleted at the end (login refused afterwards)

</details>
