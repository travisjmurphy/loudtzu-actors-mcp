import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildTools, type ActorTool } from "./actors.js";
import { runActorSync, ApifyError } from "./apify.js";

export const SERVER_NAME = "loudtzu-actors-mcp";
export const SERVER_VERSION = "0.1.0";

export interface ServerConfig {
  token?: string;
  maxChargeUsd?: number;
  maxReturnItems?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const num = (v?: string) => (v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : undefined);
  return {
    token: env.APIFY_TOKEN,
    maxChargeUsd: num(env.MAX_CHARGE_USD) ?? 1,
    maxReturnItems: num(env.MAX_RETURN_ITEMS) ?? 200,
    baseUrl: env.APIFY_API_BASE_URL || undefined,
  };
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };

export async function callActorTool(t: ActorTool, args: Record<string, unknown>, cfg: ServerConfig): Promise<ToolResult> {
  const { runOptions, ...input } = (args ?? {}) as { runOptions?: { maxTotalChargeUsd?: number; timeoutSecs?: number } } & Record<string, unknown>;
  const cap = runOptions?.maxTotalChargeUsd ?? cfg.maxChargeUsd;
  try {
    const items = await runActorSync({
      token: cfg.token ?? "",
      actorId: t.actorId,
      input,
      maxTotalChargeUsd: cap,
      timeoutSecs: runOptions?.timeoutSecs,
      baseUrl: cfg.baseUrl,
      fetchImpl: cfg.fetchImpl,
    });
    const limit = cfg.maxReturnItems ?? 200;
    const shown = items.slice(0, limit);
    const truncated = items.length > shown.length;
    const summary: Record<string, unknown> = { actor: `${t.actorId.replace("~", "/")}`, itemCount: items.length, returned: shown.length, truncated, maxTotalChargeUsd: cap, items: shown };
    if (items.length === 0) {
      // A run can SUCCEED with 0 rows: filters matched nothing, or the source site blocked the Actor (seen live Nov 12 2026). Applies to every tool.
      summary.note = `The run finished but returned 0 rows. Either nothing matched the filters, or the source was unavailable/blocked for this run. Try broader filters, or retry later; check the run log in Apify Console (${t.storeUrl}).`;
    }
    return {
      content: [{ type: "text", text: JSON.stringify(summary) }],
      structuredContent: summary,
    };
  } catch (e) {
    const msg = e instanceof ApifyError ? e.message : `Unexpected error: ${(e as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

export function createServer(cfg: ServerConfig = configFromEnv()): Server {
  const tools = buildTools();
  const byName = new Map(tools.map((t) => [t.tool, t]));
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.tool,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema as { type: "object"; properties?: Record<string, unknown> },
      annotations: { title: t.title, readOnlyHint: true, openWorldHint: true, idempotentHint: false, destructiveHint: false },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const t = byName.get(req.params.name);
    if (!t) return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
    return callActorTool(t, (req.params.arguments ?? {}) as Record<string, unknown>, cfg);
  });

  return server;
}
