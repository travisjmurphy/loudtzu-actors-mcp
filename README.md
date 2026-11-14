# LOUDTZU Canada Data & Price Tools (MCP server)

<!-- mcp-name: io.github.travisjmurphy/loudtzu-actors-mcp -->

An MCP server that gives AI agents issued building permits from 19 Canadian cities, plus federal corporations, government recalls, CRA registered charities, and small-business funding programs. It also includes retail price tools for Best Buy Canada, Loblaw-banner grocery stores, and any Shopify or WooCommerce store, for 9 tools in all.

Each tool runs one of LOUDTZU's public [Apify](https://apify.com/loudtzu) Actors **on your own Apify account**, using your `APIFY_TOKEN`. You pay Apify directly at the Actor's pay-per-event price (listed below and in every tool description). This server adds no fee of its own.

> Not affiliated with or endorsed by Apify, Best Buy, Loblaw Companies, Shopify, WooCommerce/Automattic, or any government body. Government data comes from official open-data portals under their open licences.

## Tools

| Tool | What it returns | Price (Apify pay-per-event) |
|---|---|---|
| `canada_building_permits` | Issued building permits from 19 Canadian cities, plus optional planning, licence, federal award and CanadaBuys tender signals | $0.003 per permit |
| `loblaws_grocery_prices` | Grocery prices across the 14 Loblaw banners at a chosen store: sale/unit price, deals, PC Optimum points | $0.0005 per product |
| `canada_federal_corporations` | Federally incorporated corporations (Corporations Canada open data): number, BN, names, status, dates, city, province | $0.003 per corporation |
| `shopify_store_products` | Full product export from any Shopify store: prices, compare-at, variants/SKUs, stock | $0.0005 per run + $0.00019 per product |
| `woocommerce_store_products` | Product export from any WooCommerce store via its public Store API | $0.0005 per run + $0.00026 per product |
| `canada_recalls` | Government of Canada recalls and safety alerts (Health Canada, CFIA, Transport Canada) | $0.003 per notice |
| `bestbuy_ca_product_search` | bestbuy.ca prices by province, savings, sale end date, stock and pickup | $0.0006 per product |
| `canada_registered_charities` | CRA registered charities: BN, name, designation, category, city, province | $0.003 per charity |
| `canada_business_funding_finder` | Curated Canadian small-business funding programs with amounts, deadlines, eligibility | $0.01 per program |

Prices were read from the Apify Store on Nov 11, 2026 and can change; the Actor's Store page is authoritative. Apify may also bill platform usage depending on your plan.

Each tool's input schema is generated from the Actor's own input schema, so filters and limits match the Store version. Every tool also accepts an optional `runOptions` object: `maxTotalChargeUsd` (a hard cost cap for that call) and `timeoutSecs`.

## Install

You need Node.js 18+ and an Apify account with an API token (Console > Settings > API & Integrations).

```json
{
  "mcpServers": {
    "loudtzu": {
      "command": "npx",
      "args": ["-y", "loudtzu-actors-mcp"],
      "env": { "APIFY_TOKEN": "<your Apify token>", "MAX_CHARGE_USD": "1" }
    }
  }
}
```

Docker: `docker build -t loudtzu-actors-mcp . && docker run -i --rm -e APIFY_TOKEN=... loudtzu-actors-mcp`

| Env var | Default | Meaning |
|---|---|---|
| `APIFY_TOKEN` | (required) | Your Apify token. Charges bill to this account. |
| `MAX_CHARGE_USD` | `1` | Per-call cap on Actor charges, sent to Apify as `maxTotalChargeUsd`. |
| `MAX_RETURN_ITEMS` | `200` | Max rows returned to the agent per call (the full count is reported). |

## How it works

Each call is `POST https://api.apify.com/v2/acts/loudtzu~<actor>/run-sync-get-dataset-items` with your token in the `Authorization` header and the tool arguments as the Actor input. Apify's synchronous limit is 300 seconds; for big pulls, lower `maxItems` or narrow the filters.

## Why use this instead of Apify's own MCP server?

[Apify's official MCP server](https://mcp.apify.com) can already search and run any public Actor, including these (for example `https://mcp.apify.com?tools=loudtzu/canada-building-permits`). If you already use it, you do not need this package. What this one adds:

- A fixed, curated set of 9 Canada-focused tools, so an agent sees them in `tools/list` without searching the Store first.
- Results come back inline as rows in one call. Apify's generic `call-actor` tool returns the run status and storage IDs, and a second call reads the dataset.
- Agent-oriented descriptions with use cases and prices, cleaned JSON schemas, and a default $1 per-call cost cap.

## Development

```bash
npm install
npm test          # mocked fetch only; no live Apify calls
npm run build
npm run gen       # refresh src/actors.generated.json from the Actors' input_schema.json files
```

MIT licence (the wrapper only; the Actors themselves are not included).
