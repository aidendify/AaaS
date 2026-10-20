# Demo script check

Checked by `node --test test/demo-stories.test.mjs` against a local server with `AI_PROVIDER=mock`, `AI_MOCK=on`, and `CHANNELS_MOCK=on`. No video was recorded.

A FAIL below is a step the app still does not do: the widget clock is the server clock, opening the chat page does not show earlier messages, qualify questions stay the built-in ads/email/website/retainer prompt, and website chat does not ask for a name. Every other step passed in that run.

## Clinic · Saturday laser

| Step | Result | What the app did |
|---|---|---|
| Chief answers the goal in plain English | PASS | The Chief reply is a sentence about approval and does not contain a [mock] line. |
| Weekday hours picker is on Front desk | PASS | The served page builds a checkbox and time for each day, including Saturday, and posts by_day. An empty week is rejected. |
| Different hours per day are used in replies | PASS | Monday is offered 10:00–12:00. Tuesday is closed, in those words. |
| Saturday laser question is drafted with Saturday slots | PASS | The draft has the price, Saturday 11:00–13:00, and Saturday times. Nothing is booked or sent. |
| Widget shows 10:47pm | FAIL | The chat page has no 10:47pm clock. The message time is the server clock (stored on the message). |
| Opening the chat shows the approved reply | FAIL | Opening the chat page does not load earlier messages. The script fetches only after the visitor submits. |
| The approved reply is delivered, and booking still needs a second approval | PASS | Approve with an empty edit delivers the Saturday reply. It is visible on the visitor’s next message. |
| The first slot is a second draft | PASS | book 1 drafts a confirmation. The appointment is not stored yet. |
| The appointment is stored only after the confirmation is approved | PASS | The booking appears after Approve, with a mock calendar id. |
| Evening-before reminder is drafted at 18:00 the day before | PASS | The run is due at 18:00 the day before. An earlier tick does not draft it. The tick at that time drafts a web chat reminder and does not send it. |

## Coach · Fees, discovery call, follow-up

| Step | Result | What the app did |
|---|---|---|
| Telegram owner message reaches the Chief as a real sentence | PASS | The owner chat is delivered. The reply is a canned sentence, not a [mock] line. |
| The fee answer is drafted and held | PASS | “What are your fees?” waits in Approvals. |
| Approving the fee delivers it and does not book a call | PASS | The fee reply is sent only after Approve. No appointment is stored. |
| Qualify questions are specific to a coach | FAIL | The next question is still the built-in ads, email, website, or retainer prompt. |
| Interest, budget, and email are stored | PASS | The contact keeps interest email, budget 20000, and the example.com address. |
| The discovery call is booked only after approval | PASS | book 1 stays a draft. The booking exists after that confirmation is approved. |
| A quiet-lead follow-up is drafted by the tick, and approving it does not send | PASS | The cron tick queues “Following up”. Approving that draft does not send it. |

## Broker · 3BHK, site visit, Monday suggestion

| Step | Result | What the app did |
|---|---|---|
| Chief answers the listing goal in plain English | PASS | The Chief reply is a sentence and does not contain a [mock] line. |
| Listings support add, edit, delete, and CSV import | PASS | CSV import stored the 3BHK and kept a formula cell as text. Edit and delete work. The other account cannot see or change the row. |
| “3BHK still available?” is answered from the listing and held | PASS | The draft quotes Lakeview Residency and does not offer slots. Nothing is sent. |
| Website chat asks for a name | FAIL | The lead is still “Website visitor”. The chat did not ask for a name. |
| Saturday site-visit times are offered | PASS | The visit draft offers Saturday 11:00–13:00 only. |
| The site visit is confirmed only after approval | PASS | The confirmation stays a draft until Approve. |
| Owner sets Ananya Rao and the timeline shows the visit | PASS | The contact name is Ananya Rao. The timeline includes Call booked. |
| Monday suggestion applies as a draft and does not send | PASS | Apply saved a draft workflow. sent is false. |

## Salon / gym · Slot, trial, every Friday

| Step | Result | What the app did |
|---|---|---|
| Slack owner DM reaches the Chief as a real sentence | PASS | The Slack DM is delivered. The reply is a canned sentence, not a [mock] line. |
| “Slot at 6?” offers 18:00 | PASS | The draft offers 18:00. The unfiltered openings include another time, so 18:00 is the clock in the question. |
| The 6pm booking waits for approval | PASS | The confirmation is stored only after Approve, at 18:00. |
| The trial answer is its own draft | PASS | “Trial class?” drafts the saved answer and does not book a slot. |
| The trial slot is a separate approval | PASS | Asking for a slot after the trial answer is a new draft. The booking waits for its own approval. |
| “Every Friday…” told to the Chief creates a weekly draft | PASS | The Chief saved a Friday workflow. It is off, and the WhatsApp step needs approval. |
| A booking exists on the day after the Friday run | PASS | The offered Saturday matches the day after the scheduled Friday. |
| The Friday tick drafts the reminder and does not send it | PASS | Ticking an hour early does nothing. Ticking the stored Friday time drafts the web chat reminder even if the step was set to auto. |
| “Every fortnight…” is refused | PASS | The Chief and the workflow box both explain the supported schedules. No fortnight workflow is saved. |

## Agency · White-label workspace

| Step | Result | What the app did |
|---|---|---|
| Chief answers the agency goal in plain English | PASS | The Chief reply is a sentence and does not contain a [mock] line. |
| Creating a client does not send email | PASS | The client response says no email was sent and no payment was taken. |
| Saving a hostname does not change DNS | PASS | The branding response documents the CNAME and says saving it does not change DNS or issue a certificate. |
| Markup is saved and is not a charge | PASS | 20% AI markup, ₹2 a message, and ₹40 a lead are saved. payment is false. |
| The agency playbook installs as drafts | PASS | Preview does not install. Confirm writes the workflows as drafts and sends nothing. |
| View-as is read only | PASS | The view-as session can read the draft workflow and cannot turn it on. |
| The usage summary is not a payment | PASS | The invoice route sets payment false. The printable page says it is not a tax invoice and does not take payment. |

Totals: 37 passed, 4 failed.
