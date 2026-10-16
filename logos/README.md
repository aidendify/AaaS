# Connector logos

Put each brand's official logo here (SVG or PNG, square works best), taken from the company's brand or press page
and used under its brand guidelines. Then list it in `WP_LOGOS` near the top of the Connectors code in `index.html`:

```js
const WP_LOGOS={ gmail:'logos/gmail.svg', gcal:'logos/google-calendar.svg', gdrive:'logos/google-drive.svg' };
```

Connector ids: finance, gmail, gcal, gdrive, github, box, canva, notion, shopify, stripe, vercel, wix, m365, outlook,
gsheets, dropbox, granola, zoom, calendly, slack, teams, whatsapp, twilio, hubspot, salesforce, zendesk, intercom,
mailchimp, asana, jira, confluence, linear, trello, figma, airtable, postgres, quickbooks, xero, docusign.

Any connector without a listed file shows a neutral icon in the brand colour.
