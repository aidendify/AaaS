# AaaS on an existing EC2 instance

This is a setup guide. Nothing in this folder creates an AWS resource, and this change does not deploy the app.

Use it when the clinic build should run on a box you already have (one EC2 instance in Mumbai, or any region). The cheaper high-availability plan (ALB, ECS, RDS) stays in `docs/DEPLOY-AWS.md`. This path is one server, nginx, TLS, and Postgres.

The image is the repo `Dockerfile`. `docker-compose.yml` in this folder publishes port 3000 on `127.0.0.1` only. nginx is the public listener. The container health check calls `GET /api/health`.

## What the app already exposes

| Check | What it tells you |
| --- | --- |
| `GET /api/health` | `{ ok, auth, db }`. Use this for nginx, Docker, and an uptime check. |
| `GET /api/health/deep` | 200 when the database answers, 503 when it does not. No customer rows. |

Neither response includes secrets or clinic records.

## 1. Box

- Ubuntu on the EC2 instance. Security group: 22 from your IP, 80 and 443 from the internet. Do not open 3000.
- Install Docker and the compose plugin, plus nginx and certbot (`certbot` and `python3-certbot-nginx`).
- Clone this repo to `/opt/aaas`. Do not copy a `.env` from a laptop into git.

## 2. Environment file

Create `/etc/aaas.env` on the server, mode `600`, owner root. Start from `.env.example`. Put real values only in this file.

Required for this layout:

| Variable | Why |
| --- | --- |
| `SESSION_SECRET` | `openssl rand -hex 32`. Signs login tokens. |
| `DATABASE_URL` | Postgres (RDS in the same VPC, or Neon). `HOSTED=1` in the compose file refuses to boot on the file store without it. |
| `APP_URL` | `https://clinic.example.com` |
| `CRON_SECRET` | Only if something outside the process calls `/api/cron/tick`. The long-lived server runs its own minute loop. |
| `HOST` | Leave the compose value `0.0.0.0` inside the container. The published port stays on loopback. |

Optional, still only in `/etc/aaas.env`:

| Variable | Why |
| --- | --- |
| `CLINIC_DEMO` | `1` shows **Explore the sample clinic**. Leave unset or `0` on a clinic’s own server. |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | Real drafts. Empty: screens and sample data still work. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google sign-in. Redirect is `/clinic`. |
| `EKA_CLIENT_ID` / `EKA_CLIENT_SECRET` | Live Eka.care sync. See developer.eka.care. Never commit these. |
| `EKA_BASE_URL` | Default `https://api.eka.care`. |
| `EKA_CLINIC_ID` | Optional filter on the appointment list. |
| `CLINIC_CONNECTOR_WEBHOOK_SECRET` | Turns on `POST /api/clinic/connectors/webhook/<form token>`. Header `X-AaaS-Connector-Secret`. |

`ALLOW_FILE_STORE` stays unset. The image does not copy `.env` (see `.dockerignore`).

## 3. Start the app

From `/opt/aaas`:

```bash
docker compose -f deploy/aws/docker-compose.yml up -d --build
curl -fsS http://127.0.0.1:3000/api/health
```

Expect `"ok": true`. If the database is down, fix `DATABASE_URL` before pointing DNS here. `GET /api/health/deep` returns 503 in that case.

## 4. nginx and TLS

```bash
sudo cp deploy/aws/nginx-clinic.conf.example /etc/nginx/sites-available/aaas
# edit server_name
sudo ln -s /etc/nginx/sites-available/aaas /etc/nginx/sites-enabled/aaas
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d clinic.example.com
```

Certbot renews on its own timer. After TLS works, `curl -fsS https://clinic.example.com/api/health`.

Open `https://clinic.example.com/clinic` and create the owner account. Admin setup, if you need it, is `/setup` once, using the one-time code in `docker compose logs`.

## 5. Backups

Clinic rows live in the same Postgres table as the rest of AaaS (`agentsphere_kv`).

1. Put `DATABASE_URL` and a long `BACKUP_KEY` in the root-only env file. Do not print them.
2. Nightly, from the box or a trusted machine that can reach the database:

```bash
export AIDENTIFY_ENV_FILE=/etc/aaas.env
export BACKUP_KEY='the long random string from the password manager'
node scripts/db-backup.mjs backup --schema public --out /var/backups/aaas
```

If the compose project uses a schema other than `public`, pass that name. Copy the encrypted file off the box (S3 or another disk). Keep 14 daily copies. Details and the restore drill are in `docs/BACKUPS.md`.

Also snapshot the Docker volume if you ever run with `ALLOW_FILE_STORE=1` for a single-server test. Production on this guide uses Postgres, so the database backup is the one that matters.

Before each update: take a backup, then `git pull` and `docker compose -f deploy/aws/docker-compose.yml up -d --build`.

## 6. What this guide does not do

- It does not open a security group, allocate an IP, or change DNS for you.
- It does not send email, SMS, or a payment.
- It does not replace the receptionist, and it does not turn on a paid WhatsApp API.
- Remote browser stays off (`REMOTE_BROWSER` unset).
