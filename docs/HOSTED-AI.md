# AI on the hosted demo: shared key, $10 cap, and bring-your-own-key

## How a new user gets AI
1. They create an account on the demo home and can chat with Chief of Staff right away.
2. During onboarding ("Tell Chief of Staff about the business") there is an optional **Use your own AI key** section.
   Leave it empty → they use the shared platform key with a free daily allowance.
   Paste an OpenRouter (or OpenAI / xAI / Google Gemini / Anthropic) key → it is checked once with the provider, stored
   AES-256-GCM encrypted (`as_aikey:<email>`, key derived from `SESSION_SECRET`), and all their AI calls use it. No limits
   from us; their provider bills them.
3. Later: user menu → **AI key**, or Settings → **AI key**, to add, change or remove it. Only the last 4 characters are shown.

With BYOK, the shared key is never used as a silent fallback for that user. Keys are never logged or returned by any API.

## The $10 cap on the shared key: two layers
### 1. Hard cap at OpenRouter (recommended, do this once)
OpenRouter enforces a credit limit per API key, so the demo can never spend more than the limit even if the app is wrong.
1. Go to https://openrouter.ai/settings/keys and click **Create API key**.
2. Name: `aidentify-demo`. **Credit limit: 10** (USD). Reset: **No reset** (a one-off $10 pool) — or Weekly/Monthly if you want it to refill.
3. Copy the key and replace the Vercel value (never paste it into Slack or git):
   `printf '%s' "<key>" | vercel env add OPENROUTER_API_KEY production --scope aidentify --yes --force` (and `preview`), then `vercel deploy --prod --scope aidentify`.
4. Check: `curl -s -H "Authorization: Bearer <key>" https://openrouter.ai/api/v1/key` shows `limit: 10`.
An existing key's limit can also be edited on the same page (⋯ → Edit → Credit limit).

### 2. Soft cap in the app (`lib/aikeys.js`)
Spend on the shared key is recorded per call in `as_sys_aipool` (OpenRouter's real `usage.cost`; other providers are estimated
at $3 / $15 per million tokens in / out). Calls are refused with a friendly "add your own key" message when:

| Env var | Default | Meaning |
| --- | --- | --- |
| `PLATFORM_AI_BUDGET_USD` | unset (off) | Total shared budget. Set to `10` on the demo. Turns the soft cap on. |
| `PLATFORM_AI_STOP_AT` | `0.95` | Stop at this fraction of the budget (one call can overshoot). |
| `PLATFORM_AI_DAILY_USD` | `2` | Shared pool per day (IST), so $10 lasts at least 5 days. |
| `PLATFORM_AI_USER_DAILY_CALLS` | `60` | Model calls per customer per day on the shared key (one chat can be a few calls). |
| `PLATFORM_AI_USER_DAILY_USD` | `0.5` | Spend per customer per day on the shared key. |

Staff accounts skip the per-customer limits but still count toward the total and daily pool. Routines and public pages count
toward the pool too. BYOK users are not limited.
