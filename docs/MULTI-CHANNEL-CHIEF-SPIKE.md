# Multi-channel Chief — spike plan (PR3, v2.7.0 parallel/individual-launch)

Status: plan only. No code changed. No new deps.

## Existing hooks (inventory)
- `package.json`: `@whiskeysockets/baileys ^6.7.24` already a dependency (npm ci warns about its install script). `qrcode`, `pino` used by waqr.
- `lib/waqr.js` (272 lines): Baileys QR session already. `startWaqr/stopWaqr/stopAllWaqr/resumeLinkedSessions`, `sendToLinkedOwner`, `waqrMaySend(to, owner)`, `routeWaqrSender`, `setWaqrOwnerHandler`, `assertWaqrAvailable` (refuses serverless), `WAQR_WARNING` ban-risk copy. Owner-self-chat only; never messages customers.
- `lib/channels.js` (726 lines): sealed per-email creds (`withCreds`, key = sha256(secret+':channels')), index claims, `ingestInbound` (whatsapp/sms/webchat/telegram/slack), `holdOutbound` -> `queueApproval`, `deliverOutbound`/`providerSend` (Telegram bot API path exists, token redaction exists), `publicWebhook`, `channelRoutes`, `disconnectChannel` accepts `whatsapp_qr`, `telegram`.
- `lib/clinic-whatsapp.js`: official Meta/Gupshup env (`waEnv`, `waMockOn`), `sendDecision({configured, demo, opt, to, owner})`, opt-in/opt-out words, webhook parse.
- `lib/clinic.js`: Chief chat (clinic). Drafts -> `queueApproval`; `deliverApprovedDraft` (L1059) is the only send path, gated by `sendDecision`; demo => no send. Default copy: "Nothing is sent until you approve."
- Tests: `test/clinic-whatsapp.test.mjs`, `test/v230-channels.test.mjs`, `test/v250-free-channels.test.mjs`.

## Architecture
Channel adapters (waqr, telegram, webchat) -> `ingestInbound` -> Chief turn (clinic chat) -> reply/draft. Any outbound to a non-owner = `holdOutbound` -> approval row -> approve -> `deliverOutbound` (single gate). Owner self-chat replies from Chief are the only auto path (already in waqr).

## Session / QR flow
1. Owner opens Channels -> "Link WhatsApp (beta)" -> sees WAQR_WARNING, must tick acknowledge.
2. `startWaqr` -> Baileys emits QR -> `qrcode` data URL polled by UI.
3. Auth state sealed in channel creds per email; `resumeLinkedSessions` on boot; `stopWaqr({wipe})` on disconnect.
4. Long-lived server only (`assertWaqrAvailable`); Vercel shows "not available here".

## Telegram stub
Owner pastes BotFather token (BYO; free). Inbound via `publicWebhook` (secret_token header check). Outbound via existing `providerSend` telegram branch, only after approval. Stub test: mocked fetch, no network.

## Inbound -> Chief
`setWaqrOwnerHandler` + telegram webhook call a shared `chiefInbound(email, {channel, from, body})` that: STOP check, `looksLikeInjection` flag, `ingestInbound`, then clinic Chief answer using the owner's BYOK key (no hosted AI fallback).

## Outbound approval-first
No adapter exports a direct send to customers. Chief tools can only call `holdOutbound`. Approve endpoint -> `deliverOutbound`. Test asserts no provider call without approved approvalId.

## Tenant isolation keys
Creds sealed per `email`; index claims (`claimIndex`) map phone/bot-id -> one email; conversations `CONV+email`; waqr sessions keyed by email in memory map; webhook resolves tenant by index, never by body field.

## DEMO
`c.demo` / `waMockOn` => adapters return fake QR + mock transport; no Baileys import, no api.telegram.org. Test: demo path with fetch stub that throws if called.

## Ban-risk copy (UI)
Use `WAQR_WARNING` verbatim; plus "Use a number you can afford to lose. For customer messaging use the official WhatsApp Business API." Label "Unofficial · Beta".

## Test plan
- unit: chiefInbound routing, isolation (two emails, same peer), demo no-network, approval gate, telegram webhook secret mismatch 401, token redaction.
- run `npm test`; counts must not drop.

## Out of scope
Paid BSPs, broadcasts, customer-initiated auto-replies via WAQR, group chats, media, hosted AI, Vercel/AWS deploy.

## Proposed next commits (not done)
1. `lib/chief-inbound.js` + test (shared router, demo/no-network).
2. Telegram webhook secret + approval-gate tests.
3. UI acknowledge checkbox + ban-risk copy.
