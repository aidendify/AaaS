# Monitoring, alerting and rollback (v1.15)

## Health endpoints (public, no customer data, no secrets)
- `GET /api/health`: quick liveness (200 and `ok: true`).
- `GET /api/health/deep`: database round trip (`db.ok`, `db.ms`), version, commit, region, whether AI is ready (or on mock), and the last cron run (`cron.lastAt`, `cron.ok`, `cron.hoursAgo`). It answers **503** when the database doesn't respond.
- Every API request already writes one JSON log line (route, status, ms, AI calls and cost; no emails or tokens) — see `lib/obs.js`. Admins see the same numbers at `/api/admin/metrics`.

## Simple alerting plan (free tier is enough to start)
| What | How | Alert when |
|---|---|---|
| Site up | UptimeRobot / Better Stack free monitor on `https://<prod>/api/health/deep` every 5 min, keyword `"ok":true` | 2 failures in a row (≈10 min) → email + WhatsApp/Slack |
| Database | same monitor (deep returns 503) | as above |
| Daily cron | a second keyword monitor: `"hoursAgo":` value ≤ 26 (or Better Stack heartbeat) | cron missed a day, or `cron.ok:false` |
| Errors | Vercel → Project → Logs, filter `status>=500`; weekly look at `/api/admin/metrics` | > 1% 5xx in an hour (manual for now; Vercel log drains need Pro) |
| AI spend | the existing caps ($10 total, $2/day, per-user limits) + admin metrics | 80% of a cap (already shown in admin) |

Set up for **staging first**, then prod with the owner's approval. Alerts go to the owner's email; nothing posts publicly.

## One-command rollback (Vercel)
```bash
scripts/vercel-rollback.sh aidentify-staging list         # recent production deployments
scripts/vercel-rollback.sh aidentify-staging              # back to the previous one (instant, no rebuild)
scripts/vercel-rollback.sh aidentify-staging <url>        # back to an exact deployment
scripts/vercel-rollback.sh aidentify-staging undo         # promote the newest again
```
- `aidentify-demo` (live) asks you to type `yes` first. Only do it with the owner's go-ahead.
- Rollback changes the code only. If a release changed data, restore a backup too (docs/BACKUPS.md).
- After a Vercel rollback, new `--prod` deploys are **not** put on the domain automatically. Run `undo` (or `vercel promote <url>`) once the fix is out.

## Costs (approximate, Oct 2026; check the vendors' pricing pages before buying)
| Item | Now | When we charge customers |
|---|---|---|
| Vercel | Hobby (free, **non-commercial only**) | Pro, about $20 per member per month. Required before taking money. |
| Neon Postgres | Free plan (small storage, short restore window) | Paid plan, roughly $20–70 per month, for a longer restore window and more compute |
| AI (OpenRouter) | Capped at $10 total, $2 per day | Per-customer caps and their own keys (BYOK) keep this on the customer |
| Uptime monitor | Free tier | ~$0–25/month |
| Backups | On the box (free) | S3, a few cents per GB per month |
| **Total to launch** | **≈ $0** | **≈ $45–120 per month** |
