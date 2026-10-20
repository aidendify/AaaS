# Local demo videos

Five social walkthroughs of AIdentify, recorded against a local server. The videos are not committed. This folder is the recorder.

The server is started with `AI_PROVIDER=mock`, `AI_MOCK=on`, and `CHANNELS_MOCK=on`, and a fresh data directory under `/tmp`. Nothing here talks to a hosted demo, a real inbox, or a real phone number. Every email is on `.example` or `example.com`.

```bash
node scripts/demo-videos/run.mjs
ONLY=clinic node scripts/demo-videos/run.mjs
```

`ONLY` is a comma list: `clinic`, `coach`, `broker`, `studio`, `agency`. `ONLY=seed` stops after the fake accounts exist.

Finished files are written to `/opt/cursor/artifacts/` (override with `DEMO_ARTIFACTS`):

- `clinic_laser_16x9.mp4` and `clinic_laser_9x16.mp4`
- `coach_fees_16x9.mp4` and `coach_fees_9x16.mp4`
- `broker_3bhk_16x9.mp4` and `broker_3bhk_9x16.mp4`
- `studio_friday_16x9.mp4` and `studio_friday_9x16.mp4`
- `agency_whitelabel_16x9.mp4` and `agency_whitelabel_9x16.mp4`

Each file is a 3.5s title card plus the walkthrough, with burned-in captions, silent stereo audio, 60–90 seconds. The 9:16 cut scales the full 16:9 frame into a 1080×1920 canvas and redraws the captions larger underneath. It is not a centre crop.

Playwright records at 1920×1080. The website-chat page is only a short title and a small box in the corner, so the recorder centres and enlarges that box in the page for the camera. The usage summary is the real HTML from `GET /api/agency/invoice.html`; the recorder restacks those same figures in larger type so they survive the vertical frame. Neither change is in the product.

## What the product actually does

These beats are in the stories because the code does not do the thing the sentence sounds like.

- **Saturday hours.** The front desk form saves start, end, and slot length. It does not send `days`. Saturday-only hours are set through `POST /api/frontdesk/availability` before the camera rolls.
- **“Is Saturday free for laser?”** does not offer slots by itself. A saved answer with that question returns the price and the hours. A later “book a slot” offers the three times.
- **Website chat history.** Opening the chat page does not load earlier messages. The approved reply appears when the visitor sends the next message. Until then the box is empty.
- **10:47pm** is a caption. The widget stores the server’s clock.
- **Chief replies** on this server are the mock line `[mock …] Here is a draft for: …`. Customer sends still sit in Approvals until Approve. An owner’s own Telegram or Slack chat is delivered, because that chat is the owner talking to the Chief.
- **Approve on a channel reply.** The button sends `edit: {}`. That used to be rejected for web chat, so nothing was delivered. Empty edits are ignored now, and the reply is sent only after Approve.
- **“Evening before”** does not set a clock. The sentence compiles to a WhatsApp that needs approval, plus an in-app reminder that does not message the patient.
- **“Every Friday…”** does not compile. The recorder shows that error, then the sentence the compiler accepts: a weekly WhatsApp that stays on needs approval. “Bookings tomorrow” is not its own rule.
- **“Slot at 6?”** matches the word “slot”. The 6:00 time is the first opening because the hours are 18:00–19:30, not because the phrase names 6pm.
- **3BHK.** There is no listings database. The answer is a saved FAQ that names the fictional Lakeview Residency.
- **Qualify.** The built-in questions are ads, email, the website, or a retainer, then budget, then an email. A fee answer does not also qualify.
- **Website chat names.** The lead is “Website visitor” until someone sets a name. The broker shot sets Ananya Rao on the contact before opening the timeline.
- **Monday suggestion.** It appears after a weekly review of this account’s own email opens (four Monday sends opened, four mid-week sends not opened). Apply saves a draft. It does not send.
- **Silent-lead follow-up.** Creating the lead only queues the workflow. The draft appears in Approvals after the routine tick (`GET /api/cron/tick`). The row is titled “Email: Following up”, and approving a draft does not send it.
- **Agency.** A client is created without an email. Branding a hostname does not change DNS. Playbooks install as drafts. View-as is read only for about two hours. The usage page is a summary with markup, not a tax invoice and not a payment.
