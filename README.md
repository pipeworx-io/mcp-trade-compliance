# @pipeworx/trade-compliance

US import compliance — CBP customs ruling letters (CROSS) and antidumping / countervailing duty (AD/CVD) orders. Keyless, no auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1857+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

Answers the two questions the tariff schedule alone cannot: *how has Customs classified this product before* and *is there a trade-remedy duty on it from this country*.

## Tools

- `cross_search(query, hts?, since?, limit?)` — search CBP CROSS ruling letters for tariff classification precedent. Returns ruling number, date, subject, assigned HTS numbers, and whether the ruling was later modified or revoked.
- `cross_ruling(ruling_number, max_chars?)` — one ruling letter in full: the facts, CBP's analysis, and the holding.
- `adcvd_orders(product?, country?, hts?, limit?)` — AD/CVD orders by product and/or country, grouped per product-country pair with current status and case numbers.
- `adcvd_case(case_number | document_number)` — every Federal Register notice on file for one AD/CVD case.

## Auth

None. Both upstreams are public US government endpoints with no key and no registration.

## Two things that will bite you

**AD/CVD scope is set by scope language, not by HTS code.** The HTS numbers in an AD/CVD notice are advisory cross-references. Merchandise can be *in* scope under an HTS code that looks unrelated, or *out* of scope under one that looks like a match. Never conclude "not covered" because an HTS code is absent — read the scope language in the linked notice. Every `adcvd_orders` response carries this as `scope_note`.

**`adcvd_orders` reports recent order activity, not a census.** It searches the 100 most recent matching Federal Register notices, newest first. China has hundreds of AD/CVD orders in place; a country-only query returns the handful with recent order, continuation, or revocation notices. Treat an absence as *"no recent notice found"*, not *"no order exists"*. Every response carries this as `coverage_note`.

### Status values

`adcvd_orders` resolves a status per product-country pair:

| status | meaning |
|---|---|
| `in_place` | latest action was an order, continuation, or amendment |
| `in_place_revoked_in_part` | Commerce revoked the order for named companies or a carved-out subset — **still in force for everyone else** |
| `revoked` | order revoked in full |

The partial case is the common one and the dangerous one to flatten: reporting it as `revoked` would tell an importer a duty is gone when it still applies to them.

## Notes on the upstreams

- **CROSS returns HTTP 500 for a ruling number that does not exist**, not a 404, and serves its SPA's `index.html` with a 200 for any unknown path. `cross_ruling` therefore probes with a second search call to tell "no such ruling" (`reason: ruling_not_found`) from a genuine outage (`reason: upstream_error`), and every response is JSON-parsed rather than trusted by status.
- **CROSS search rows carry `tariffs`/`categories`; the detail endpoint returns them null.** `cross_ruling` merges the search row so tariff numbers are present either way.
- **AD/CVD case numbers come from the Federal Register list endpoint's `docket_ids`** — no per-document fetch needed. Elements are sometimes one code and sometimes several comma-joined in a single string, so codes are regexed out of the joined array rather than trusted per element.
- **Federal Register full-text search is noisy**: a query mentioning China returns notices about Japan. Product and country are parsed out of the notice *title* and filtered on the parsed values, never on the query terms.
- **Order type comes from case-number prefixes** (`A-` antidumping, `C-` countervailing), not title text — titles share "Duty" across a conjunction ("Antidumping and Countervailing Duty Orders"), which defeats naive phrase matching.

## Related packs

- `hts` — the duty *rates* themselves (MFN, FTA preferential, Section 301/232 add-ons).
- `sanctions-screening` — restricted-party and forced-labor screening, including the DHS UFLPA Entity List.
- `census-trade`, `comtrade` — trade *flows*.

## Data sources

- CBP CROSS: `https://rulings.cbp.gov/api/search`, `https://rulings.cbp.gov/api/ruling/<number>`
- Federal Register (International Trade Administration notices): `https://www.federalregister.gov/api/v1/documents.json`

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "trade-compliance": {
      "url": "https://gateway.pipeworx.io/trade-compliance/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/trade-compliance/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1857+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/cross_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"lithium ion battery pack","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/cross_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-trade-compliance` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/trade-compliance/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "trade-compliance": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-trade-compliance"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Trade Compliance data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
