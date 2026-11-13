import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, configFromEnv } from "../src/server.js";
import { buildTools } from "../src/actors.js";

const REQUIRED = ["canada-building-permits", "canada-federal-corporations", "shopify-store-products", "woocommerce-store-products"];

async function connect(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  const server = createServer({ token: "test-token", maxChargeUsd: 1, maxReturnItems: 2, fetchImpl, ...extra });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe("catalog", () => {
  const tools = buildTools();
  it("has 9 tools including the 4 required Actors, with unique valid names", () => {
    expect(tools).toHaveLength(9);
    for (const r of REQUIRED) expect(tools.map((t) => t.actor)).toContain(r);
    const names = tools.map((t) => t.tool);
    expect(new Set(names).size).toBe(9);
    for (const n of names) expect(n).toMatch(/^[a-z0-9_]{1,64}$/);
  });
  it("every tool has an agent-findable description, price, store link and object schema", () => {
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(150);
      expect(t.description).toContain("https://apify.com/loudtzu/");
      expect(t.description).toMatch(/\$\d/);
      expect(t.inputSchema.type).toBe("object");
      expect(Object.keys(t.inputSchema.properties as object)).toContain("runOptions");
      expect(JSON.stringify(t.inputSchema)).not.toMatch(/"editor"|"prefill"|proxyConfiguration/);
    }
  });
  it("loblaws keeps its required keywords", () => {
    expect(tools.find((t) => t.actor === "loblaws-grocery-prices")!.inputSchema.required).toEqual(["keywords"]);
  });
});

describe("MCP server (mocked fetch, no live calls)", () => {
  it("lists all tools over MCP with read-only annotations", async () => {
    const client = await connect(vi.fn() as never);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(9);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("calls the right Actor, strips runOptions from input, applies charge cap and truncates output", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify([{ i: 1 }, { i: 2 }, { i: 3 }]), { status: 200 }));
    const client = await connect(f as never);
    const res = await client.callTool({ name: "bestbuy_ca_product_search", arguments: { keywords: ["tv"], maxItems: 3, runOptions: { maxTotalChargeUsd: 0.25 } } });
    expect(res.isError).toBeFalsy();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.pathname).toBe("/v2/acts/loudtzu~bestbuy-ca-product-search/run-sync-get-dataset-items");
    expect(u.searchParams.get("maxTotalChargeUsd")).toBe("0.25");
    expect(JSON.parse(init.body as string)).toEqual({ keywords: ["tv"], maxItems: 3 });
    const sc = res.structuredContent as { itemCount: number; returned: number; truncated: boolean };
    expect(sc).toMatchObject({ itemCount: 3, returned: 2, truncated: true });
  });

  it("uses the server default cap when the caller gives none", async () => {
    const f = vi.fn(async () => new Response("[]", { status: 200 }));
    const client = await connect(f as never, { maxChargeUsd: 0.4 });
    await client.callTool({ name: "shopify_store_products", arguments: { storeUrls: ["https://example.com"] } });
    expect(new URL((f.mock.calls[0] as unknown as [string])[0]).searchParams.get("maxTotalChargeUsd")).toBe("0.4");
  });

  it("adds the 0-row 'source may be blocked' note for every tool", async () => {
    const f = vi.fn(async () => new Response("[]", { status: 200 }));
    const client = await connect(f as never);
    const { tools } = await client.listTools();
    for (const t of tools) {
      const res = await client.callTool({ name: t.name, arguments: {} });
      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as { itemCount: number; note?: string };
      expect(sc.itemCount).toBe(0);
      expect(sc.note).toMatch(/0 rows/);
      expect(sc.note).toMatch(/blocked/);
    }
    expect(f).toHaveBeenCalledTimes(9);
  });

  it("does not register or list walmart_ca_product_search in v0.1.0", async () => {
    const client = await connect(vi.fn() as never);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("walmart_ca_product_search");
    const r = await client.callTool({ name: "walmart_ca_product_search", arguments: {} });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("Unknown tool");
  });

  it("returns isError for API failures and unknown tools", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { type: "not-enough-usage", message: "Out of credit" } }), { status: 402 }));
    const client = await connect(f as never);
    const r1 = await client.callTool({ name: "canada_recalls", arguments: {} });
    expect(r1.isError).toBe(true);
    expect(JSON.stringify(r1.content)).toContain("not-enough-usage");
    const r2 = await client.callTool({ name: "nope", arguments: {} });
    expect(r2.isError).toBe(true);
  });

  it("returns a clear error when APIFY_TOKEN is missing", async () => {
    const f = vi.fn();
    const client = await connect(f as never, { token: undefined });
    const r = await client.callTool({ name: "cra_charities_missing", arguments: {} });
    expect(r.isError).toBe(true);
    const r2 = await client.callTool({ name: "canada_registered_charities", arguments: {} });
    expect(JSON.stringify(r2.content)).toContain("APIFY_TOKEN");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("configFromEnv", () => {
  it("defaults to a $1 cap and 200 returned items", () => {
    expect(configFromEnv({})).toMatchObject({ maxChargeUsd: 1, maxReturnItems: 200 });
    expect(configFromEnv({ APIFY_TOKEN: "x", MAX_CHARGE_USD: "0.1", MAX_RETURN_ITEMS: "5" })).toMatchObject({ token: "x", maxChargeUsd: 0.1, maxReturnItems: 5 });
  });
});
