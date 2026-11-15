import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import { buildTools, type ActorTool } from "../src/actors.js";

const ajv = new Ajv({ allErrors: true, strict: false });

const EXPECTED_TOOLS = [
  "canada_building_permits",
  "loblaws_grocery_prices",
  "canada_federal_corporations",
  "shopify_store_products",
  "woocommerce_store_products",
  "canada_recalls",
  "bestbuy_ca_product_search",
  "canada_registered_charities",
  "canada_business_funding_finder",
] as const;

/** Representative valid inputs for each tool (no network calls). */
const VALID_INPUT: Record<(typeof EXPECTED_TOOLS)[number], Record<string, unknown>> = {
  canada_building_permits: { cities: ["halifax", "calgary"], maxItems: 3, province: "NS" },
  loblaws_grocery_prices: { keywords: ["milk", "eggs"], banner: "nofrills", language: "en" },
  canada_federal_corporations: { province: "NS", statusGroup: "active", maxItems: 10 },
  shopify_store_products: { storeUrls: ["https://www.allbirds.com"], maxProductsPerStore: 20 },
  woocommerce_store_products: { storeUrls: ["https://mercantile.wordpress.org"], onSaleOnly: true },
  canada_recalls: { keyword: "listeria", language: "en", maxItems: 5 },
  bestbuy_ca_product_search: { keywords: ["laptop"], province: "NS", sort: "priceLow" },
  canada_registered_charities: { year: "2024", keyword: "food bank", maxItems: 10 },
  canada_business_funding_finder: { query: "grant", minVerificationLevel: "partial", maxItems: 20 },
};

function schemaOf(t: ActorTool) {
  return t.inputSchema as object;
}

function validate(t: ActorTool, data: unknown) {
  const v = ajv.compile(schemaOf(t));
  return { ok: v(data) as boolean, errors: v.errors ?? [] };
}

describe("tool definitions", () => {
  const tools = buildTools();
  const byName = new Map(tools.map((t) => [t.tool, t]));

  it("exports the nine catalogued tools in a stable order, with unique MCP names", () => {
    expect(tools.map((t) => t.tool)).toEqual([...EXPECTED_TOOLS]);
    expect(new Set(tools.map((t) => t.actor)).size).toBe(9);
    expect(new Set(tools.map((t) => t.actorId)).size).toBe(9);
    for (const t of tools) {
      expect(t.tool).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      expect(t.actorId).toBe(`loudtzu~${t.actor}`);
      expect(t.storeUrl).toBe(`https://apify.com/loudtzu/${t.actor}`);
      expect(t.title.length).toBeGreaterThan(8);
      expect(t.price).toMatch(/\$\d/);
    }
  });

  it("gives every tool a JSON object schema with runOptions limits and no Apify-only keys", () => {
    for (const t of tools) {
      const schema = t.inputSchema;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      const properties = schema.properties as Record<string, Record<string, unknown>>;
      expect(properties.runOptions).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      const runProps = properties.runOptions.properties as Record<string, Record<string, unknown>>;
      expect(runProps.maxTotalChargeUsd).toMatchObject({ type: "number", minimum: 0 });
      expect(runProps.timeoutSecs).toMatchObject({ type: "integer", minimum: 10, maximum: 300 });
      expect(JSON.stringify(schema)).not.toMatch(/"editor"|"prefill"|proxyConfiguration/);
    }
  });

  it("only requires keywords on loblaws_grocery_prices", () => {
    expect(byName.get("loblaws_grocery_prices")!.inputSchema.required).toEqual(["keywords"]);
    for (const t of tools) {
      if (t.tool === "loblaws_grocery_prices") continue;
      expect(t.inputSchema.required ?? []).toEqual([]);
    }
  });
});

describe("input validation (JSON Schema, no network, no token)", () => {
  const tools = buildTools();
  const byName = new Map(tools.map((t) => [t.tool, t]));

  it("accepts a valid example input for every tool, including runOptions", () => {
    for (const name of EXPECTED_TOOLS) {
      const t = byName.get(name)!;
      const base = VALID_INPUT[name];
      expect(validate(t, base).ok, `${name} should accept ${JSON.stringify(base)}`).toBe(true);
      expect(
        validate(t, { ...base, runOptions: { maxTotalChargeUsd: 0.25, timeoutSecs: 60 } }).ok,
        `${name} should accept runOptions`,
      ).toBe(true);
    }
  });

  it("accepts an empty object on tools with no required fields, and rejects one on loblaws", () => {
    for (const t of tools) {
      const { ok } = validate(t, {});
      if (t.tool === "loblaws_grocery_prices") expect(ok).toBe(false);
      else expect(ok).toBe(true);
    }
  });

  it("rejects missing required keywords, unknown properties, wrong types, and out-of-range values", () => {
    const loblaws = byName.get("loblaws_grocery_prices")!;
    const permits = byName.get("canada_building_permits")!;
    const bestbuy = byName.get("bestbuy_ca_product_search")!;

    expect(validate(loblaws, { banner: "nofrills" }).ok).toBe(false);
    expect(validate(loblaws, { keywords: "milk" }).ok).toBe(false);
    expect(validate(permits, { cities: ["halifax"], unexpected: true }).ok).toBe(false);
    expect(validate(permits, { maxItems: 0 }).ok).toBe(false);
    expect(validate(permits, { maxItems: "10" }).ok).toBe(false);
    expect(validate(permits, { province: "QC" }).ok).toBe(false);
    expect(validate(bestbuy, { province: "XX" }).ok).toBe(false);
    expect(validate(bestbuy, { sort: "cheapest" }).ok).toBe(false);
  });

  it("validates runOptions caps and rejects unknown runOption keys", () => {
    const t = byName.get("canada_recalls")!;
    expect(validate(t, { runOptions: { maxTotalChargeUsd: 1, timeoutSecs: 300 } }).ok).toBe(true);
    expect(validate(t, { runOptions: { maxTotalChargeUsd: -1 } }).ok).toBe(false);
    expect(validate(t, { runOptions: { timeoutSecs: 5 } }).ok).toBe(false);
    expect(validate(t, { runOptions: { timeoutSecs: 301 } }).ok).toBe(false);
    expect(validate(t, { runOptions: { token: "nope" } }).ok).toBe(false);
  });
});
