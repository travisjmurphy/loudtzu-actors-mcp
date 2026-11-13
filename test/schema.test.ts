import { describe, it, expect } from "vitest";
import { apifyToJsonSchema, convertProp } from "../src/schema.js";

describe("apifyToJsonSchema", () => {
  it("strips Apify-only keys and proxyConfiguration, keeps types/enums/limits", () => {
    const s = apifyToJsonSchema({
      properties: {
        q: { title: "Query", type: "string", editor: "textfield", description: "What to search" },
        n: { title: "Max", type: "integer", default: 100, minimum: 1, maximum: 500 },
        sort: { type: "string", editor: "select", enum: ["a", "b"], default: "a" },
        proxyConfiguration: { type: "object", editor: "proxy" },
      },
      required: ["q", "proxyConfiguration"],
    });
    expect(Object.keys(s.properties as object)).toEqual(["q", "n", "sort"]);
    expect(s.required).toEqual(["q"]);
    expect(s.additionalProperties).toBe(false);
    const p = s.properties as Record<string, Record<string, unknown>>;
    expect(p.q).toEqual({ type: "string", description: "Query. What to search" });
    expect(p.n).toMatchObject({ type: "integer", default: 100, minimum: 1, maximum: 500 });
    expect(p.sort.enum).toEqual(["a", "b"]);
    expect(JSON.stringify(s)).not.toContain("editor");
  });

  it("maps requestListSources arrays to {url} objects and stringList to strings", () => {
    expect(convertProp({ type: "array", editor: "requestListSources" }).items).toMatchObject({ type: "object", required: ["url"] });
    expect(convertProp({ type: "array", editor: "stringList", prefill: ["x"] })).toMatchObject({ items: { type: "string" }, description: 'Example: ["x"]' });
    expect(convertProp({ type: "array", items: { type: "string", enum: ["a"] } }).items).toEqual({ type: "string", enum: ["a"] });
  });

  it("drops null defaults and clips very long descriptions", () => {
    const p = convertProp({ type: "string", default: null, description: "x".repeat(2000) });
    expect(p.default).toBeUndefined();
    expect((p.description as string).length).toBeLessThanOrEqual(600);
  });
});
