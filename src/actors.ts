import raw from "./actors.generated.json" with { type: "json" };
import { apifyToJsonSchema, type JsonSchema } from "./schema.js";

export const APIFY_USERNAME = "loudtzu";

export interface ActorTool {
  tool: string;
  actor: string;
  actorId: string;
  title: string;
  price: string;
  description: string;
  storeUrl: string;
  inputSchema: JsonSchema;
}

interface RawEntry {
  tool: string; actor: string; actorId: string; title: string; price: string; description: string;
  apifyInputSchema: { properties: Record<string, Record<string, unknown>>; required?: string[] };
}

export const RUN_OPTIONS_SCHEMA: JsonSchema = {
  type: "object",
  description: "Optional run limits (not passed to the Actor). maxTotalChargeUsd caps what this single call can cost you on Apify.",
  properties: {
    maxTotalChargeUsd: { type: "number", minimum: 0, description: "Hard cap in USD for this run's Actor charges. Defaults to the server's MAX_CHARGE_USD (1.00 unless set)." },
    timeoutSecs: { type: "integer", minimum: 10, maximum: 300, description: "Run timeout in seconds (Apify's synchronous limit is 300)." },
  },
  additionalProperties: false,
};

export function buildTools(): ActorTool[] {
  return (raw as unknown as RawEntry[]).map((r) => {
    const base = apifyToJsonSchema(r.apifyInputSchema as never);
    const properties = { ...(base.properties as Record<string, JsonSchema>), runOptions: RUN_OPTIONS_SCHEMA };
    return {
      tool: r.tool,
      actor: r.actor,
      actorId: `${APIFY_USERNAME}~${r.actor}`,
      title: r.title,
      price: r.price,
      storeUrl: `https://apify.com/${APIFY_USERNAME}/${r.actor}`,
      description: `${r.description} Runs the Apify Actor ${APIFY_USERNAME}/${r.actor} on your own Apify account (pay per event: ${r.price}, billed by Apify; Apify platform usage may apply). Store page: https://apify.com/${APIFY_USERNAME}/${r.actor}`,
      inputSchema: { ...base, properties },
    };
  });
}
