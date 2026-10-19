# Backups and restore (v1.15)

All app data lives in one Postgres table (`agentsphere_kv`) per schema: `demo` (live), `staging`. One script backs it up and restores it: `scripts/db-backup.mjs`.

## Two layers
1. **Neon's own history (point-in-time restore).** Neon keeps a history window and can branch the database at a past moment from its console. This is the fastest fix for "something broke an hour ago". The window is short on the free plan and longer on paid plans, so check the project's setting.
2. **Our own backup files** (this script). These cover longer periods, moving to another host (AWS), and the case where the Neon account itself is lost.

## Commands (run on a trusted machine; DATABASE_URL from the env file, never printed)
```bash
export AIDENTIFY_ENV_FILE=/path/to/prod-or-staging.env   # holds DATABASE_URL (+ DATABASE_SCHEMA)
export BACKUP_KEY='<long random string kept in the password manager>'   # encrypts the file
node scripts/db-backup.mjs backup --schema demo --out /secure/backups
node scripts/db-backup.mjs verify --file /secure/backups/aidentify-demo-<time>.json.gz.enc
node scripts/db-backup.mjs restore --file <file> --schema restore_20261020        # into a NEW schema
node scripts/db-backup.mjs drill --schema staging --out /secure/backups           # the restore drill below
```
- Files are gzip JSON with a row count and a sha256 hash. `verify` and `restore` refuse a file whose hash doesn't match.
- With `BACKUP_KEY` the file is AES-256-GCM encrypted. Without it, the file holds customer data in the clear.
- Restore refuses to write into `demo` or `public` unless you pass `--yes`, and it always refuses a schema that already has rows.
- The normal recovery path is:
  1. Restore into a new schema.
  2. Check it on staging.
  3. Point `DATABASE_SCHEMA` at it in Vercel.
  4. Redeploy.

## Schedule (plan)
- Daily: back up `demo` from the box, encrypted. Keep 14 daily and 8 weekly copies, and keep a copy outside the box (Drive or S3).
- Before every prod release: take a backup, then deploy.
- Monthly: run the restore drill and write the result below.

## Restore drill
1. Run `node scripts/db-backup.mjs drill --schema staging`. It:
   1. backs up the schema;
   2. restores it into a throw-away schema `restore_drill_<id>`;
   3. compares the row count and hash;
   4. drops the throw-away schema;
   5. keeps the backup file.
2. Write the date, row count, time taken and result in the log below.

| Date (IST) | Schema | Rows | Restore time | Result |
|---|---|---|---|---|
| 20 Oct 2026, 00:41 | staging | 13 | 7.0 s | Compare OK, drill schema dropped |

## Not covered
- Vercel settings and env vars: keep them in the password manager. `vercel env pull` re-creates a local copy.
- Code: GitHub is the source of truth. Release tags let you rebuild any version.
- A deploy rollback (`scripts/vercel-rollback.sh`) does not roll back data. Restore a backup for that.
