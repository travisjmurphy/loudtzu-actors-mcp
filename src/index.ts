#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer();
await server.connect(new StdioServerTransport());
if (!process.env.APIFY_TOKEN) {
  console.error("[loudtzu-actors-mcp] APIFY_TOKEN not set: tools will list, but calls will return an error until you set it.");
}
