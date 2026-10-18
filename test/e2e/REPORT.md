# AIdentify end-to-end scenario report

Written by `npm run e2e`. Each run appends a section below. The findings summary at the top is written by hand.

## Summary (19 Oct 2026, v1.8.0 on staging)

- **Runs.** The first mock-AI run passed 3 of 4 scenarios: one 500 error (F1). After the fixes the mock-AI run passed 4 of 4, and one real-AI run passed 4 of 4.
- **Real AI spend for the whole job: about $0.0023.** That's 24 shared-key calls on `deepseek/deepseek-v4-flash`, measured from the staging spend log.
- **Mock-AI spend:** $0. The ~$0.0024 of made-up mock cost also sits in the staging spend log.
- **Cleanup:** every throwaway `e2e-…@example.com` account was deleted. A database check afterwards found no test account and no test workspace left in schema `staging`.

| # | Finding | Severity | Evidence | Status / suggested fix |
|---|---|---|---|---|
| F1 | A broken JSON body returned **500** on Vercel instead of a clean 400. Locally it was already 400. | Medium | Run 00:45 IST, scenario d: `HTTP 500 server_error` | **Fixed (v1.8.0).** `api/index.js` catches Vercel's lazy JSON parse error and returns `400 bad_json`. |
| F2 | Deleting an account left its **public link tokens** (`as_tok:<token>` rows) in place. They still held the deleted email and pointed at the deleted account. | Medium (privacy) | After the first run, 2 `as_tok` rows in `staging` still pointed at deleted e2e accounts | **Fixed (v1.8.0).** Account delete (self and admin) now removes them. New test `test/delete-cleanup.test.mjs` fails without the fix. The 2 orphan rows on staging were cleared. The demo schema may have old orphans; it wasn't touched. |
| F3 | `GET /api/kv` reads **every row in the database** (`st.all()`) and then filters to the caller. Every workspace load gets slower as customers are added, and it moves other customers' rows through the function. | High (scale) | `lib/backend.js` `/api/kv` GET handler; ~0.9 s with only a handful of users | Phase 3: read only the caller's keys (`listPrefix` / `where k in (…)`), plus the few shared keys. |
| F4 | **Fixed overhead per request** is high even with zero-latency mock AI. Each Neon query costs ~100–250 ms and requests run several in sequence. Mock `/api/ai` p50 1.15 s, `PUT /api/kv` 1.6 s, signup 0.75 s, **account delete 4.4 s**. | Medium | `/api/admin/metrics` after the mock run | Phase 3: cache the users row per request, batch reads, run independent writes in parallel, and delete rows instead of writing one tombstone per key. |
| F5 | **Real-AI latency is close to Vercel's 60 s limit.** Agent chat p50 20 s, max 30 s. One short `/api/ai` draft took 36.6 s. The public qualify page made the visitor wait 19 s. `LLM_TIMEOUT_MS` defaults to 180 s, longer than the 60 s function limit, so a slow provider ends in a Vercel timeout instead of a clean error. | Medium | Real run 00:59 IST, metrics for that window | Phase 2/3: set `LLM_TIMEOUT_MS≈45000` on hosted (and cap agent steps); use async jobs or streaming for chat; public pages shouldn't wait on AI (reply first, summarise later). |
| F6 | A fresh account **can't get any approval** from the agent until it connects an app: `propose_action` needs a connected app, and `send_email` / `social_post` only exist with Gmail / Buffer. Approving an action on a key-based connection (e.g. Trello) **always fails** with "needs Composio", so approved actions on those apps can never run on hosted. | Medium (product) | Scenario a needed a fake Trello connection. The approved item ended `failed` (safe, nothing left the server) | Phase 3: explain this at onboarding, add a built-in "draft only" approval type, and either wire direct actions for key-based connectors or hide them. |
| F7 | `POST /api/routines` only accepts a **daily hour:minute**. There's no one-off "follow up in 3 days" through the API, though the agent's own `create_routine` tool supports `first_run`. The test had to wait for the next clock minute. | Low | Scenario b | Phase 3: accept `first_run` + `repeat_every_days` on the API, matching the agent tool. |
| F8 | No hosted scheduler: the routine ran only because the test called `/api/cron/tick` itself. | Known gap, confirmed | Scenario b | Phase 3: Vercel cron (daily on Hobby) or an outside pinger every minute. |
| F9 | The shared **spend log keeps deleted accounts' emails** (`as_sys_aipool` days → users). | Known gap, confirmed | 2 e2e emails in the staging pool after the first run | Phase 3: key the per-user counters by a hash of the email, or drop them on delete. A hash still stops "delete and sign up again" from resetting the daily allowance. |
| F10 | Deletes write `null` **tombstone rows** instead of removing them: 56 already on staging. | Low | Neon count in `staging` | Phase 3: delete rows, or purge tombstones nightly. |
| F11 | There's no business-profile field or signup step. The profile only exists as workspace JSON or agent knowledge, and `/api/ai` never sees it. | Known gap, confirmed | Scenario a note | Phase 3: profile step at signup, injected into `/api/ai` and agent prompts. |
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
