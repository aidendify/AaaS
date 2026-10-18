# Staging and test tooling

## Staging copy
- URL: https://aidentify-staging.vercel.app (Vercel project `aidentify-staging`, team `aidentify`). Deploys are CLI-only, from a separate folder linked to that project, so a deploy can never land on `aidentify-demo` or `aidentify`.
- Database: the same Neon database as the demo, but its own schema `staging`. The app creates the schema and tables on first start (`DATABASE_SCHEMA=staging`).
- AI: `PLATFORM_AI_BUDGET_USD=2` with a $2 daily pool, plus its own `SESSION_SECRET`, `CRON_SECRET` and admin password. The values live only in Vercel and in a chmod 600 file on the box, never in git.
- Normally it runs on the **mock AI** (`AI_PROVIDER=mock` + `AI_MOCK=on`), so tests cost nothing. To run on real AI, remove those two variables and redeploy. When you're done, put them back.

## Mock AI (`lib/llm.js`)
- It only turns on when **both** `AI_PROVIDER=mock` and `AI_MOCK=on` are set. Neither variable exists on the demo or the landing site, so they can't fall into mock by accident.
- While it's on, it's the only AI provider and never falls back to a real, paid one. Answers are fixed for a given prompt: `[mock <hash>] Here is a draft for: …`. Token counts and costs are fake but realistic, and they flow through the normal spend hooks, so caps and logs still get exercised.
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
