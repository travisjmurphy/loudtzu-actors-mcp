// Minimal Apify API client: runs an Actor synchronously and returns its dataset items.
// Uses the caller's own token, so Actor pay-per-event charges bill to the caller's Apify account.

export interface RunOptions {
  token: string;
  actorId: string;
  input: Record<string, unknown>;
  maxTotalChargeUsd?: number;
  timeoutSecs?: number;
  maxItems?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class ApifyError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "ApifyError";
  }
}

export const DEFAULT_BASE_URL = "https://api.apify.com";

export function buildRunUrl(o: Pick<RunOptions, "actorId" | "maxTotalChargeUsd" | "timeoutSecs" | "maxItems" | "baseUrl">): string {
  const u = new URL(`/v2/acts/${encodeURIComponent(o.actorId)}/run-sync-get-dataset-items`, o.baseUrl ?? DEFAULT_BASE_URL);
  u.searchParams.set("format", "json");
  u.searchParams.set("clean", "true");
  if (o.maxTotalChargeUsd !== undefined) u.searchParams.set("maxTotalChargeUsd", String(o.maxTotalChargeUsd));
  if (o.timeoutSecs !== undefined) u.searchParams.set("timeout", String(o.timeoutSecs));
  if (o.maxItems !== undefined) u.searchParams.set("maxItems", String(o.maxItems));
  return u.toString();
}

export async function runActorSync(o: RunOptions): Promise<unknown[]> {
  if (!o.token) throw new ApifyError("APIFY_TOKEN is not set. Create a token at https://console.apify.com/settings/integrations and set it in the MCP server's env.");
  const f = o.fetchImpl ?? fetch;
  const res = await f(buildRunUrl(o), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${o.token}` },
    body: JSON.stringify(o.input ?? {}),
  });
  const text = await res.text();
  if (res.status === 408) {
    throw new ApifyError("The Actor run took longer than Apify's 300-second synchronous limit. Ask for fewer items (lower maxItems) or narrower filters and try again.", 408);
  }
  if (!res.ok) {
    let msg = text.slice(0, 500);
    try {
      const j = JSON.parse(text) as { error?: { type?: string; message?: string } };
      if (j.error) msg = `${j.error.type ?? "error"}: ${j.error.message ?? ""}`;
    } catch { /* keep raw text */ }
    throw new ApifyError(`Apify API returned ${res.status}. ${msg}`, res.status);
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new ApifyError("Apify returned a non-JSON response."); }
  if (!Array.isArray(data)) throw new ApifyError("Apify returned an unexpected response (expected a JSON array of items).");
  return data;
}
