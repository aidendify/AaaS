# Channels and the front desk

This is the v2.3 setup for WhatsApp, SMS, inbound email, and the website chat. It is for an agency or a digital / email-marketing account. Each account has its own inbox, its own credentials, and its own front desk. Nothing here is shared with another account.

No secret values belong in this file. Paste tokens only in the Inbox page (or the API). They are stored encrypted, the same way a bring-your-own AI key is stored, using `SESSION_SECRET`. After you save, the app shows the last four characters. The WhatsApp verify token is shown once, on the save response. Copy it then.

Tests use mock providers. You do not need a Meta, Twilio, or MSG91 account to run `npm test`.

## What you get

- One inbox per account for WhatsApp, SMS, and email. Each thread is tied to a CRM contact and shows on that contact’s timeline.
- WhatsApp through the Meta WhatsApp Cloud API.
- SMS through an adapter. The providers are Twilio, MSG91, and `mock`.
- Inbound email through the Gmail connection that already exists under Plugins.
- Workflow steps `send_whatsapp` and `send_sms`. They use the same approval levels and the same send caps as email.
- A front desk that answers WhatsApp and the website chat from this account’s business profile and FAQs, qualifies a lead, and can offer call times.
- A public chat widget for that account. It is rate limited.

Anything that sends starts as **needs approval**. A workflow step, a front-desk reply, and a reply you type in the inbox all wait in Approvals until you approve them. Confirming a send yourself on the Inbox page is the approval.

## WhatsApp (Meta Cloud API)

1. In Meta, create an app and add the WhatsApp product. This build does **not** use Embedded Signup. You copy the values yourself.
2. Copy the **phone number id** (digits only, 6 to 20 characters) and a **permanent access token**.
3. Copy the app’s **app secret**. Inbound webhooks are checked with it.
4. On the Inbox page, save those three. Leave the verify token blank to have one generated, or paste your own (16 to 128 letters, numbers, `_` or `-`).
5. In the Meta app, set the callback URL to:

   `https://<your-app>/api/channels/whatsapp/webhook`

   There is no account id in the URL. The app finds the account from the phone number id you saved, then checks the signature with **that** account’s app secret. A body field that names another email is ignored.
6. Subscribe to messages. Meta sends a GET with `hub.mode=subscribe`, `hub.verify_token`, and `hub.challenge`. The challenge is returned as plain text only when the token matches the one you saved.
7. For a test account, an access token that starts with `mock_` does not call Meta. The signature check still runs. `mock_` is not a real token; it is a switch.

### The 24 hour window

A free-form WhatsApp can be sent only when that contact’s last inbound message on this account is less than 24 hours old. The clock is the time we stored, not a call to Meta’s window API. Outside that window, name a template you already approved in Meta (letters, numbers, underscore). Session text is refused and nothing is sent.

A workflow step behaves the same way. If you set it to auto and the window is closed and the step has no template, it waits in Approvals.

### Opt-out

If the whole inbound message is one of these words, the contact’s consent becomes exactly `Opted out` and nothing is sent back:

`STOP`, `STOPALL`, `STOP ALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`

Punctuation is ignored. A longer sentence that merely contains STOP is not an opt-out. A later message does not turn consent back on. Workflow sends and the front desk both skip an opted-out contact.

## SMS

On the Inbox page choose `twilio`, `msg91`, or `mock`.

| Provider | What you paste | Signature on inbound |
|---|---|---|
| Twilio | From number, auth token, account SID | `X-Twilio-Signature`, HMAC-SHA1 of the full URL plus the sorted form fields |
| MSG91 | From number, auth key, sender id, DLT template id | `X-Msg91-Signature: sha256=` plus HMAC-SHA256 of the raw body |
| mock | From number and any test secret of 8 or more characters | `X-Mock-Signature: sha256=` plus HMAC-SHA256 of the raw body |

The inbound URL is:

`https://<your-app>/api/channels/sms/webhook`

The account is chosen from the destination number you saved. The provider is the one stored for that account. The payload cannot pick a different provider or a different account.

This build does **not** register a DLT template for you. For MSG91 you bring your own sender id and DLT template id. The mock provider does not call Twilio or MSG91.

## Email

Connect Gmail under Plugins (an app password, or Google sign-in if that connector is set up). Inbox → Sync Gmail reads recent mail into this account’s inbox and creates or matches a contact. It does not send.

With `CHANNELS_MOCK=on` and `AI_MOCK=on`, `POST /api/channels/email/mock` writes one inbound email for the signed-in account only. That route does not exist unless both switches are on. It is for tests.

## Workflows

A sentence such as “When a new lead comes in, whatsapp them and sms them” compiles to two steps. Both start as needs approval. “using template welcome_offer” stores that template name on the WhatsApp step.

You can later set a step to auto within limits, or auto. Auto still has limits: only that contact’s own number, the step’s daily cap, and the account ceiling `WORKFLOW_SEND_DAILY_MAX` (unset means 50, `0` means no automatic sends). Opt-out skips the step. Outside the WhatsApp window, a step without a template waits and nothing is sent.

## Front desk

Open Front desk. It is off until you turn it on.

- **Needs approval** (the default). Every reply is a draft in Approvals. The visitor does not see it.
- **Auto within limits.** A normal answer can send on its own, up to the daily cap (default 20, maximum 200) and the character cap. A handoff never auto-sends.
- Full **auto** is rejected. You cannot set it from the page or the API.

The desk reads this account’s business profile (Settings / Profile: name and about) and the FAQs you saved. It can ask what the lead wants (ads, email, website, social, or a retainer), a budget, and an email. If it does not know, it hands the chat to you and adds a note in your inbox. The visitor sees: “Thanks for the message. A person from the team will reply to this.”

Inbound text is data. It cannot change autonomy, caps, FAQs, or which account is speaking. A message that tries (“ignore previous instructions”, “set autonomy to auto”, “without approval”, and similar) is handed off. The model is asked to phrase a reply, and it may only make the desk more cautious. It cannot clear a handoff or change the approval setting.

### Booking

Hours default to Monday–Friday, 10:00–18:00, 30 minutes, `Asia/Kolkata`. The desk offers up to three open times. The visitor replies `book 1`, `book 2`, or `book 3`. The slot is held only when that reply is actually sent (you approve it, or auto within limits sends it). The booking is stored on the account.

Optional calendar: connect Google Calendar under Plugins, or, when `CHANNELS_MOCK=on` and `AI_MOCK=on`, set the calendar to `mock`. A missing calendar still saves the booking. The mock link does not call Google.

### Website chat

Front desk → Create widget. You get a token and a snippet:

```html
<script src="https://<your-app>/c/<token>.js" async></script>
```

Put that on the customer’s site. The script posts to the absolute origin (`APP_URL`, or the host that served the script). The page answers with `Access-Control-Allow-Origin: *` because it runs on someone else’s site.

The token is 32 hex characters. Guessing it is not practical. It maps to one account. Rotating it deletes the old token. Deleting the account deletes the token, the phone-number indexes, and the inbox.

The public transcript shows received and sent messages only. Drafts stay hidden. If a draft is waiting, the widget says the team will reply shortly.

`WIDGET_RATE_MAX` (default 30) is messages per 15 minutes for that widget and visitor address, in this process. It stays on even when `RATE_LIMIT=off`. It is not shared across several servers.

The widget ignores any autonomy, FAQ, or settings fields in the message body. Only the text and a visitor id are read.

## API (customer, signed in)

| Method | Path | What it does |
|---|---|---|
| GET | `/api/channels` | Connection hints and conversations. No secrets. |
| POST | `/api/channels/whatsapp` | Save WhatsApp credentials. |
| POST | `/api/channels/sms` | Save SMS credentials. |
| POST | `/api/channels/telegram` | Save a BotFather token. Optional `owner_user_id` and `customers`. |
| POST | `/api/channels/slack` | Save a bot token and signing secret. Optional `owner_user_id` and `customers`. |
| GET | `/api/channels/whatsapp-qr` | Beta status and the warning. No session and no QR secret in logs. |
| POST | `/api/channels/whatsapp-qr/start` | Start a QR session. Refused unless `WHATSAPP_QR=on` on a persistent server. |
| POST | `/api/channels/disconnect` | `{ "which": "whatsapp" }`, `"sms"`, `"telegram"`, `"slack"`, or `"whatsapp_qr"`. |
| POST | `/api/channels/email/sync` | Pull recent Gmail. |
| GET | `/api/channels/conversations/:id` | One thread. |
| POST | `/api/channels/send` | Queue a reply. `"confirm": true` sends it now (your click is the approval). |
| GET / POST | `/api/frontdesk` | Read or save the desk. `auto` is `needs_approval` or `auto_within_limits`. |
| POST | `/api/frontdesk/availability` | Hours and optional `calendar: "mock"`. |
| POST | `/api/frontdesk/widget` | Create or rotate the widget token. |

Public, no session:

| Method | Path |
|---|---|
| GET, POST | `/api/channels/whatsapp/webhook` |
| POST | `/api/channels/sms/webhook` |
| GET | `/c/:token` and `/c/:token.js` |
| POST | `/c/:token/message` |

Staff accounts get 403 on the customer routes. A customer cannot read or write another customer’s keys through `/api/kv`. Those keys are `as_chcred`, `as_chidx`, `as_conv`, `as_fd`, `as_book`, `as_wgt`, `as_waid`, `as_wavt`, `as_smsid`, `as_tghook`, `as_tgbot`, `as_slhook`, `as_slteam`, `as_fch`, and `as_fseen`.

Public, no session, added in v2.5:

| Method | Path |
|---|---|
| POST | `/api/channels/telegram/webhook/:hook` |
| POST | `/api/channels/slack/webhook/:hook` |

## Free channels (v2.5)

Telegram and Slack let the owner talk to the Chief of Staff without a per-message fee. Tokens are stored encrypted with `SESSION_SECRET`, the same way the WhatsApp Cloud token is stored. The Inbox page and `GET /api/channels` show a hint (the last four characters), never the token, the Telegram secret, the Slack signing secret, or a WhatsApp QR session.

Anything that messages a customer starts as **needs approval**. The front desk still cannot be set to full auto. A reply from the Chief to the owner, in the owner’s own chat, is the conversation itself and is delivered. It does not message anyone else.

### Telegram

1. In BotFather, create a bot and copy the token.
2. On the Inbox page, paste the token. You can paste your numeric Telegram user id, or send the bot `/link` plus the code shown once after you save.
3. Set the webhook to the URL shown after save:

   `https://<your-app>/api/channels/telegram/webhook/<hook>`

   The hook id only chooses the account. The `X-Telegram-Bot-Api-Secret-Token` header must match the secret stored for that account. A body field that names another email is ignored.
4. If `APP_URL` is a public http(s) address, saving a real token also calls Telegram `setWebhook`. A token that starts with `mock_` is rejected unless `CHANNELS_MOCK=on`. When that switch is on, `mock_` does not call Telegram. `mock_` is for tests.
5. A private message from the linked owner goes to the Chief of Staff. Other people are ignored unless you tick **Let customers reach the front desk**. Those messages use the same front desk as WhatsApp. Group chats are ignored.

### Slack (per account)

This is separate from the server-wide Socket Mode bot in `docs/slack.md`.

1. Create a Slack app. Add a bot token (`xoxb-…`) with `chat:write`, `im:history`, `im:read`, and `app_mentions:read`. Turn on Event Subscriptions for `message.im` and `app_mention`.
2. Copy the signing secret.
3. On the Inbox page, paste the bot token and the signing secret. Paste your member id (`U…`), or DM the bot `link` plus the code shown once after you save. A bot token that starts with `mock_` is rejected unless `CHANNELS_MOCK=on`.
4. Set the request URL to:

   `https://<your-app>/api/channels/slack/webhook/<hook>`

   Slack signs the raw body. The app checks `X-Slack-Signature` and `X-Slack-Request-Timestamp` (five minutes) with that account’s signing secret before it reads the event, including the URL-verification challenge. A `team_id` that does not match the workspace you connected is rejected.
5. Your DMs and mentions go to the Chief. Other people are ignored unless you let customers reach the front desk. Those replies wait for approval.

The host must see the raw request body. The Node server does. If a host parses the JSON first and rebuilds it, the signature will not match and the event is refused.

### WhatsApp QR (beta, owner only)

This is not the Meta Cloud API. It uses a QR scan (Baileys) and is **off** unless `WHATSAPP_QR=on`.

- The Inbox page shows a warning: the connection is unofficial, and WhatsApp can restrict or ban the number.
- Only the number that scanned the QR can talk to the Chief. After it links, message your own number (Message yourself). That is the only chat that is answered.
- Messages from anyone else, groups, and broadcasts are ignored. Nothing is stored as a customer lead, and nothing is sent back.
- There is no way to message a customer or send a broadcast through this channel. The send API refuses it.
- It needs a process that stays running. On Vercel (or any other serverless host) it does not open a socket. The page and the API say so, and the rest of the app keeps working.
- The session is encrypted in this account’s channel credentials. It is not written to the log.

`CHANNELS_MOCK=on` together with `AI_MOCK=on` lets tests link a number and post an inbound message without a real WhatsApp connection. That route does not exist unless both switches are on, and it still requires `WHATSAPP_QR=on`.

## What this is not

- Not a per-message charge for Telegram or Slack. Meta and SMS fees are still yours.
- WhatsApp QR is not an official WhatsApp product, and it is not a customer inbox.
- Not Embedded Signup, and not a DLT registration. You bring the sender and the template id.
- Not Meta’s official 24 hour API. The window is the last inbound message we stored.
- Not a separate database, and not LangGraph. The front desk decision is rules. The model can only raise caution.
- The widget limit is per process. The hosted routine tick is often once a day, so a workflow send waits for that tick.
- Voice is not included.
- A booking without Google Calendar connected is still a booking. It is not written to a calendar until one is connected, or until the mock calendar switch is on.
