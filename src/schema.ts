// Converts an Apify Actor input schema (https://docs.apify.com/platform/actors/development/actor-definition/input-schema)
// into a plain JSON Schema that MCP clients understand.

export type JsonSchema = Record<string, unknown>;

interface ApifyProp {
  title?: string;
  type?: string;
  description?: string;
  editor?: string;
  enum?: unknown[];
  enumTitles?: string[];
  default?: unknown;
  prefill?: unknown;
  example?: unknown;
  minimum?: number;
  maximum?: number;
  items?: Record<string, unknown>;
  [k: string]: unknown;
}

interface ApifyInputSchema {
  properties: Record<string, ApifyProp>;
  required?: string[];
}

/** Properties an agent should not set: Apify-internal plumbing with safe Actor defaults. */
export const OMITTED_PROPS = new Set(["proxyConfiguration"]);

const MAX_DESC = 600;

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_DESC ? t.slice(0, MAX_DESC - 1) + "…" : t;
}

export function convertProp(p: ApifyProp): JsonSchema {
  const out: JsonSchema = {};
  if (p.type) out.type = p.type;
  const parts = [p.title, p.description].filter(Boolean) as string[];
  if (p.prefill !== undefined && p.default === undefined) parts.push(`Example: ${JSON.stringify(p.prefill)}`);
  if (parts.length) out.description = clip(parts.join(". ").replace(/\.\./g, "."));
  if (p.enum) out.enum = p.enum;
  if (p.default !== undefined && p.default !== null) out.default = p.default;
  if (typeof p.minimum === "number") out.minimum = p.minimum;
  if (typeof p.maximum === "number") out.maximum = p.maximum;
  if (p.type === "array") {
    if (p.editor === "requestListSources") {
      out.items = { type: "object", properties: { url: { type: "string", description: "Full URL" } }, required: ["url"] };
    } else if (p.items && typeof p.items === "object") {
      const it: JsonSchema = {};
      for (const k of ["type", "enum"]) if (k in p.items) it[k] = (p.items as Record<string, unknown>)[k];
      out.items = Object.keys(it).length ? it : { type: "string" };
    } else {
      out.items = { type: "string" };
    }
  }
  return out;
}

export function apifyToJsonSchema(s: ApifyInputSchema): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const [k, v] of Object.entries(s.properties ?? {})) {
    if (OMITTED_PROPS.has(k)) continue;
    properties[k] = convertProp(v);
  }
  const required = (s.required ?? []).filter((r) => r in properties);
  const schema: JsonSchema = { type: "object", properties, additionalProperties: false };
  if (required.length) schema.required = required;
  return schema;
}
