# Contributing to AIdentify

Thanks for helping! Connectors, agent tools, docs and bug fixes are all welcome. New connectors are the most useful
contribution for agencies and small businesses.

## Development setup

```bash
git clone https://github.com/aidendify/AaaS.git && cd AaaS
npm install
cp .env.example .env      # add OPENROUTER_API_KEY (or ANTHROPIC_API_KEY); leave the rest empty to start
npm start                 # http://localhost:3000
npm run check             # syntax check, the same one CI runs
```

Plain Node.js 20, ES modules, no build step. Data goes to `data/kv.json` (git-ignored); delete `data/` to reset.

## Project layout

| Path | What it is |
|---|---|
| `server.js` | HTTP server, routines timer, board worker, Slack start-up |
| `index.html`, `board.html` | the whole web app (single files, no framework) |
| `lib/backend.js` | sign-in, storage (local file or Neon Postgres), API routes |
| `lib/orchestrator.js` | agent runs: tools, approvals, routines |
| `lib/llm.js` | model calls (OpenRouter, Anthropic) with tool calling |
| `lib/connectors.js`, `lib/composio.js`, `lib/live.js` | connectors: sign-in, encrypted credentials, live read-only readers |
| `lib/groups.js` | groups, task boards, worker loop |
| `lib/slack.js` | Slack bot (Socket Mode) |
| `lib/factory.js` | Factory tools (sandbox, publishing) and Chief ops tools |
| `lib/browser.js`, `lib/remote-browser.js` | agents' real browser and the remote browser |
| `docs/` | feature docs |

## Build a connector

A connector has up to four parts. Look at an existing one with the same shape (e.g. `hubspot` for OAuth, `trello` for
an API key) and copy it.

1. **How it connects** – `lib/connectors.js`
   - OAuth: add the provider to `GROUPS` (authorize and token URLs, plus flags such as `basic`, `json`, `pkce`,
     `scopeSep`) and add an entry to `CONNECTORS`: `myapp: { g: 'MYAPP', scope: '...' }`. The server then reads
     `MYAPP_CLIENT_ID` / `MYAPP_CLIENT_SECRET` from `.env`; the redirect URL is `<APP_URL>/api/connectors/callback`.
   - API key: `myapp: { key: [['api_key', 'API key'], ['site_id', 'Site ID']] }`. The customer pastes the fields;
     they are encrypted server-side and never sent back to the browser.
2. **The tile in the app** – add a row to the connector catalogue array in `index.html` (search for `['trello','Trello'`):
   id, name, vendor, category, icon, colour and the short descriptions. Optionally add a "where to get the key" link in `WP_CN_SITE`.
3. **Reading live data (optional but recommended)** – `lib/live.js`: add a `READERS.myapp(cr, q)` function that calls
   the provider's API read-only and returns rows `{ title, at, url, text }`, a name in `NAME`, and a topic regex in
   `TOPIC` so agents use it when a question mentions it. Agents reach it through the `read_connected_app` tool.
4. **Composio fallback (optional)** – if Composio supports the app, map it in `TOOLKIT` in `lib/composio.js` so it works
   with just `COMPOSIO_API_KEY`.

Anything that **changes** data in the connected app must go through `propose_action` / approvals, never directly.
Add the new `.env` names to `.env.example` and mention the connector in the README if it needs setup.

Not sure how to start? Open a [connector request](https://github.com/aidendify/AaaS/issues/new?template=connector_request.yml).

## Agent tools

Tools are plain objects `{ name, description, schema, run }`. Simple per-agent tools go in `lib/orchestrator.js`;
grouped tools that are switched on per agent (`agent.tools`: `sandbox`, `publish`, `ops`) live in `lib/factory.js`.
Rules: tools that send, post, publish, pay or delete must create an approval; never let an agent claim something
happened without a tool result.

## Pull requests

- One change per PR, with a clear title. Fill in the PR template.
- Run `npm run check` and start the server once (`npm start`) to make sure it boots.
- Update `CHANGELOG.md` under **Unreleased** and any docs you touched.
- Never commit `.env`, `data/`, keys, tokens or customer data.

## Releases (maintainers)

1. Move **Unreleased** items in `CHANGELOG.md` under a new version and bump `version` in `package.json`.
2. Commit, then `git tag vX.Y.Z && git push origin main --tags`.
3. `gh release create vX.Y.Z --title "AIdentify vX.Y.Z" --notes-file <changelog section>`.
   Installs and `npm run update` pick up the newest release automatically.

By contributing you agree that your work is released under the [MIT License](LICENSE) and you follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
