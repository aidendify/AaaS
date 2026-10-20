# Deploying on AWS (plan only, nothing created, no AWS spend)

When to use this: an agency or enterprise customer needs data in India, a private network, or their own AWS account, or we outgrow Vercel and Neon. The app already runs as a plain Node server (`npm start`, `Dockerfile`), so no code changes are needed.

## Shape (region ap-south-1, Mumbai)
```
Internet → Route 53 → CloudFront (optional) → ALB (public subnets, HTTPS via ACM, AWS WAF basic rules)
        → ECS Fargate service, 2 tasks (private subnets, the Dockerfile image from ECR)
        → RDS PostgreSQL (private subnets, Multi-AZ when paid customers, encrypted, 7–35 day PITR)
Outbound from tasks → NAT gateway (AI providers, Gmail/Slack APIs)
```
- **VPC:** 2 availability zones. Public subnets hold only the ALB and the NAT; app and database sit in private subnets.
  - Security groups: ALB → app on 3000 only; app → database on 5432 only.
  - The database never gets a public IP.
- **Secrets:** AWS Secrets Manager or SSM Parameter Store for `DATABASE_URL`, `SESSION_SECRET`, AI keys and `CRON_SECRET`, injected into ECS as task secrets. Nothing goes in the image or in git.
- **Cron:** an EventBridge Scheduler rule calls `POST /api/cron/tick` with `CRON_SECRET` daily at 08:00 IST. When running as a long-lived server, the built-in minute loop in `server.js` also works (`AIDENTIFY_WORKERS=on`).
- **Storage choice:** set `DATABASE_URL` to RDS. Move the data with `scripts/db-backup.mjs`:
  1. Back up from Neon.
  2. Restore into the RDS schema.
  3. Verify.
  4. Switch DNS.
- **Logs and alerts:** CloudWatch Logs (the JSON request lines), CloudWatch alarms on ALB 5xx and target health, and Route 53 health checks on `/api/health/deep`.
- **Backups:** RDS automated backups with point-in-time restore, plus the nightly encrypted `db-backup.mjs` file to an S3 bucket (versioned, SSE-KMS, lifecycle to Glacier after 30 days).
- **Deploys and rollback:**
  - GitHub Actions builds the image, pushes it to ECR, and updates the ECS service (rolling).
  - Rollback re-deploys the previous task definition revision with one CLI call: `aws ecs update-service --task-definition <prev>`.
- **Remote browser:** keep it off (`REMOTE_BROWSER` unset). It is for the owner's own box only.

## Rough monthly cost (on-demand, small; check the AWS calculator)
| Item | ≈ USD/month |
|---|---|
| Fargate 2 × (0.5 vCPU, 1 GB) | 30 |
| ALB | 20 |
| NAT gateway (1) + data | 35 |
| RDS db.t4g.micro single-AZ (Multi-AZ ≈ ×2) | 15–30 |
| CloudWatch, Secrets, S3, Route 53 | 10 |
| **Total** | **≈ 110–125** (more than Vercel Pro + Neon at our size; choose it for compliance or a customer's own account, not for cost) |

Cheaper path: one Lightsail or EC2 box in Mumbai running `docker compose`, with RDS or Neon, costs ≈ $20–40 per month. You give up high availability.

## Checklist before going live on AWS
- [ ] Owner approves the spend and the account (AWS Organizations, MFA on root, billing alarm at $50).
- [ ] Infrastructure as code (Terraform or CDK) reviewed; no click-ops.
- [ ] Restore drill run on RDS. Staging e2e passes against the AWS URL.
- [ ] DNS cut-over plan, with a rollback plan that points DNS back to Vercel.
