# Agency white-label

An agency login can hold client workspaces. Each client is still their own account. One client cannot read another client, and one agency cannot read another agency’s clients. This build does not take a payment. Early customers are invoiced by hand from the usage summary.

## Start

1. Sign in as a normal customer and open Agency.
2. Create the agency. That does not send an email and does not take a payment.
3. Add client workspaces and staff. Passwords are not emailed. Share them yourself.
4. Staff roles are owner, admin, and member. The owner sets branding and markup. An admin can add clients, members, limits, playbooks, view-as, and the usage summary. A member can look at the list, usage, and the DNS steps.

## Branding and DNS

Save a name, an https logo (or a small PNG, JPEG, GIF, or WebP), colours, a support email, and a hostname such as `app.youragency.com`.

The hostname is stored here. Saving it does not buy the name, change DNS, or issue a certificate.

1. Create a CNAME from that hostname to the host that already serves this app.
2. On a self-hosted server, point the name at the machine that already terminates TLS.
3. Open the login page on that hostname. The name, logo, colours, and support email are the agency’s.
4. After sign-in, the same brand is used in the app. The website chat uses the name and colour.

There is no domain API in this build.

## Mail

Two kinds of email:

- Sign-in codes and password resets use the server mailbox. The words and the from-name use the agency name. They are not mail to a client’s contacts.
- Mail to a client’s contacts is sent only from the Gmail that client has connected. The platform mailbox is not used for that, even when `GMAIL_USER` is set. Creating a client does not send a welcome email. The usage summary is a download, not an email.

If the client has no Gmail connected, a send waits for approval and nothing goes out.

## Playbooks, limits, view-as

Install a playbook into a client only after you confirm. The workflows stay drafts. Install does not turn them on and does not send, post, or pay.

Limits are monthly counts for that client: AI calls, AI cost in USD, messages, and leads. Empty means no cap. A full cap blocks the new lead, message, or AI call. Inbound mail over the lead cap is kept as a conversation and does not add another CRM lead, except an opt-out, which is still stored. A public form still thanks the visitor.

View-as opens the client workspace for the owner or an admin, writes an audit line first, and lasts about two hours. It is read-only. It cannot send, change settings, or open the agency page. A member cannot view-as. The Back to agency bar stays on screen, and the business-setup form does not open.

## Usage summary

Owner and admin can download a CSV or a printable HTML page for a month. AI cost stays in USD, with the agency’s percent markup. Messages and leads stay in INR at the rates the owner set. Those are not added into one pay total. The page says it is not a tax invoice. This app does not take the payment.
