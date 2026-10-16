# pi-web-cost-meter

A PI WEB plugin that shows what your agent sessions cost: per session, per day,
per model, from the token usage Pi already records.

## Requirements

- PI WEB `2.202610.11` or newer (plugin browser API v2, server API v1).
- Node.js 22.19.0 or newer on the machine running PI WEB.
- No runtime dependencies, no build step: the published `dist/` is the source of
  truth and is served as-is.

## Install

Link the folder into PI WEB's local plugin directory on the machine whose
sessions you want priced:

As a Pi package, so PI WEB discovers and can update it:

```bash
pi install git:github.com/kingoliang/pi-web-cost-meter
systemctl --user restart pi-web-sessiond   # the server half runs in the daemon
```

Or link a checkout, which is what you want while editing it:

```bash
git clone https://github.com/kingoliang/pi-web-cost-meter ~/src/pi-web-cost-meter
mkdir -p ~/.pi-web/plugins
ln -s ~/src/pi-web-cost-meter ~/.pi-web/plugins/pi-web-cost-meter
systemctl --user restart pi-web-sessiond
```

Then reload the PI WEB tab. The plugin is on by default; turn it off in
**Settings → PI WEB plugins**.

> **Editing a plugin with a server half needs the restart.** Discovery revision-hashes the
> whole package, and a browser half whose revision differs from the running server half is
> withheld from the page. Reloading the tab alone is not enough: restart the session daemon,
> then reload.

## How it works

Cost is computed, never guessed from a provider dashboard.

1. The server half reads this machine's Pi session transcripts
   (`$PI_CODING_AGENT_SESSION_DIR`, default `~/.pi/agent/sessions`) and collects
   each assistant call's token buckets: input, output, cache read, cache write.
2. Every call is priced from the price table (USD per 1,000,000 tokens) by
   matching the model id, ignoring case, spaces, punctuation and `(annotation)`
   suffixes. A model the table does not know falls back to the cost the provider
   recorded in the transcript, which beats reporting it as free.

   The table wins over a recorded cost on purpose: a recorded amount was written
   at call time, so it goes stale the moment you correct a price. Past calls are
   re-priced on every read; nothing is frozen into a ledger.
3. The browser half draws the result: a **Cost** page under each project, a cost
   line in the composer, and a price-table editor in **Settings → Cost meter**.

Transcripts are parsed once per file revision, so a page in the same period is
cheap to reopen. The scan window defaults to 90 days and is configurable.

### Where the numbers are

| Surface | What it shows |
|---|---|
| Cost page (project scope) | Selected session, machine totals for the chosen period, per model, per day |
| Composer line | Live cost and tokens for the selected session |
| Settings → Cost meter | Price table, currency, USD→CNY rate, scan window, rescan |

Currency is USD internally; `CNY` only scales the displayed amounts by the
configured rate. Recorded provider costs are assumed to be USD.

## What it reads, runs and contacts

- **Reads:** the Pi session transcripts under the agent session directory. It
  writes nothing there.
- **Writes:** one JSON document in this plugin's storage
  (`$PI_WEB_DATA_DIR/plugin-storage/cost-meter/prices.json`).
- **Runs:** no external process. Parsing uses Node streams only.
- **Network:** none. The price table ships with the plugin and is edited by hand,
  so the defaults are approximations, not a live price feed.

Nothing is sent anywhere; a transcript never leaves the machine.

## Limitations

- Auxiliary calls that a provider does not report usage for (a plugin calling an
  API directly) cannot be priced.
- The built-in prices come from the public OpenRouter model list
  (`/api/v1/models`, synced 2026-10-16 for the model families this machine
  runs). They are list prices, not your contract: check them, and fix them in
  Settings when they differ.
- This plugin does not fetch prices. Sync is a copy-paste: read
  <https://openrouter.ai/api/v1/models>, divide `pricing.*` by 1e6 and paste it
  into Settings.
- Subscription channels bill as equivalent cost, not real money.
- Sub-agent sessions are priced under their own session id.

## Development

Plain ES modules; no bundler.

```
dist/browser/pi-web-plugin.js   browser half (browser API v2)
dist/server.mjs                 server half (server API v1)
```

Edit, restart the session daemon for the server half (a browser-only change just
needs a tab reload), and reopen the page.

## Contributing

Issues and pull requests are welcome. Keep the halves dependency-free and keep
`dist/` current.

## Releasing

Bump `package.json`, add a CHANGELOG section, tag `v<version>`, and publish from
the tag.

## License

MIT
