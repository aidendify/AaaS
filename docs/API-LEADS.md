# Leads API (v1.10.0)

Add and manage CRM leads one at a time, from scripts, forms or Zapier-style tools, without rewriting the whole workspace. Leads land in the workspace's CRM agent (`agents[kind=crm].db.lead`), so the web app shows them straight away. If there's no CRM agent yet, one is created.

Auth: `Authorization: Bearer <token>`. Get the token from `POST /api/auth/login`; it lasts 14 days. Leads are customer-only, and each account sees only its own leads.

| Method | Path | What it does |
|---|---|---|
| POST | `/api/leads` | Add one lead. Returns `{ lead, created, followUp? }` |
| GET | `/api/leads` | List, newest first. Filters: `status`, `source`, `score`, `q` (name/email/phone/company/notes), `limit` (≤200, default 50), `offset` |
| GET | `/api/leads/:id` | One lead |
| PATCH | `/api/leads/:id` | Change any field or the status. Returns `{ lead, changed }` |
| DELETE | `/api/leads/:id` | Delete |

**Fields** (same as the app's CRM lead):
- **Name:** `name`, or `first_name` + `last_name`. Required.
- **Contact:** `email` and/or `phone`. At least one is required.
- **Status:** `status`, one of New / Contacted / Qualified / Unqualified / Converted / Archived. New leads default to New.
- **Picked from a list (case-insensitive):**
  - `score`: Hot / Warm / Cold
  - `consent`: Given / Unknown / Opted out
  - `channel`: Email / Phone / WhatsApp / SMS
- **Free text:** `company`, `source` (known sources like Website or LinkedIn are normalised), `interest`, `budget`, `timeline`, `score_reason`, `missing`, `owner`, `notes`.
- **Other:** `tags` (array or comma list) and `last_contact` (a date).

Bad input gets `400 bad_lead` with a plain message.

**Duplicates:** a lead with the same email (case-insensitive) or the same phone digits gets `409 duplicate`, along with the existing lead, so you can PATCH it instead. Send `"upsert": true` to update the existing lead in place.

**Follow-up:** `followUp: { "in_days": 3, "message": "…" }` or `{ "run_at": "2026-10-22T10:00:00+05:30", "message": "…" }` schedules a one-off routine for the CRM agent. When it runs, the agent drafts the follow-up for the owner's approval; nothing is sent.

**Safety:** writes run under the per-customer data lock and bump the workspace revision. An open browser tab with older data gets the usual "updated from another session" merge instead of overwriting. Writing leads never sends, posts or queues anything.

```bash
B=https://aidentify-demo.vercel.app
TOKEN=$(curl -s -X POST $B/api/auth/login -H 'Content-Type: application/json' -d '{"email":"you@example.com","password":"…"}' | jq -r .token)
curl -s -X POST $B/api/leads -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Ravi Kumar","email":"ravi@example.com","phone":"+91 90000 00000","source":"Website","notes":"Agency owner, wants WhatsApp lead follow-ups for 5 clients","followUp":{"in_days":3,"message":"Check if Ravi saw the proposal"}}'
curl -s "$B/api/leads?status=new&limit=20" -H "Authorization: Bearer $TOKEN"
curl -s -X PATCH $B/api/leads/1 -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"status":"Contacted","score":"Hot"}'
curl -s -X DELETE $B/api/leads/1 -H "Authorization: Bearer $TOKEN"
```
