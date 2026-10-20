# Staging and test tooling

## Staging copy
- URL: https://aidentify-staging.vercel.app (Vercel project `aidentify-staging`, team `aidentify`). Deploys are CLI-only, from a separate folder linked to that project, so a deploy can never land on `aidentify-demo` or `aidentify`.
- Database: the same Neon database as the demo, but its own schema `staging`. The app creates the schema and tables on first start (`DATABASE_SCHEMA=staging`).
- AI: `PLATFORM_AI_BUDGET_USD=2` with a $2 daily pool, plus its own `SESSION_SECRET`, `CRON_SECRET` and admin password. The values live only in Vercel and in a chmod 600 file on the box, never in git.
- Normally it runs on the **mock AI** (`AI_PROVIDER=mock` + `AI_MOCK=on`), so tests cost nothing. To run on real AI, remove those two variables and redeploy. When you're done, put them back.

## Mock AI (`lib/llm.js`)
- It only turns on when **both** `AI_PROVIDER=mock` and `AI_MOCK=on` are set. Neither variable exists on the demo or the landing site, so they can't fall into mock by accident.
- While it's on, it's the only AI provider and never falls back to a real, paid one. Chat answers are canned sentences chosen from the message (the same words every time for the same message). They are not a `[mock …]` line, and the mock never calls a model. Token counts and costs are fake but realistic, and they flow through the normal spend hooks, so caps and logs still get exercised.
- Tests can drive tools with `[[mock:tool_name {"json":"input"}]]` in the message. A customer key (BYOK) containing `nocredit` returns 402 and one containing `badkey` returns 401. Keys containing `mock` skip the provider check, but only on a mock server.
- `/api/health` reports `aiMock: true` while it's on.

## Observability (`lib/obs.js`)
- Every API request writes one JSON line to stdout, which Vercel logs keep: `{"t":"req","m","route","status","ms","ai","cost","mock","uid"}`.
  - `uid` is a 12-character one-way hash of the account email.
  - Tokens in `/p/*` paths are replaced with `:token`.
  - No emails, IPs, prompts or answers are logged.
  - Set `OBS_LOG=off` to silence it.
- `GET /api/admin/metrics?minutes=60` (admins only) shows requests, errors, p50/p95/max time, AI calls and cost per route, plus the shared AI pool. The request numbers cover only the server instance that answers. Serverless hosts run several instances, so treat them as a sample. The pool numbers come from the database and are exact.

## End-to-end scenarios (`test/e2e/run.mjs`)
```
E2E_CRON_SECRET=… E2E_ADMIN_EMAIL=… E2E_ADMIN_PASSWORD=… npm run e2e -- --base https://aidentify-staging.vercel.app [--only a,b] [--label "…"]
```
- Four scenarios: agency owner, lead flow, BYOK, and outside script. Each creates throwaway `e2e-<time>-<x>@example.com` accounts and deletes them at the end.
- Results are appended to `test/e2e/REPORT.md`.
- Secrets come only from environment variables. On the box, load them from the staging env file with a parser, not `source`, because the database URL contains `&`.

## Scheduler (v1.9.0)
- **Vercel cron (built in):** `vercel.json` calls `/api/cron/tick` every day at 02:30 UTC (08:00 IST). Vercel sends `Authorization: Bearer $CRON_SECRET` on its own when the project has `CRON_SECRET` set. Hobby allows once a day.
- **Every minute (free, outside):** create a job on a free pinger such as cron-job.org (or a GitHub Actions schedule, which runs about every 5–15 minutes):
  - URL: `https://<site>/api/cron/tick`
  - Method: POST
  - Header: `Authorization: Bearer <CRON_SECRET>`
  - Interval: every minute

  Due routines run on each call. Overlapping calls are safe, because each routine is locked for 10 minutes while it runs. Keep the secret only in the pinger's header settings.
- The landing project (`aidentify`) shares `vercel.json`. Its cron gets 401 because it has no `CRON_SECRET`, which is harmless.

## Region (v1.9.0)
- `vercel.json` pins functions to `sin1` (Singapore), next to the Neon database (`ap-southeast-1`) and close to users in India. Before this, functions ran in `iad1` (Washington), and every database query crossed the Pacific (about 220 ms each).
