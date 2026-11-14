#!/usr/bin/env node
// MCP server (stdio). The agent can onboard, quote, pay within limits, and read receipts.
// It can NOT change limits, allowlists, the network, reset a breaker, or sweep: those are human-only CLI commands.
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { homeDir, ensureHome, loadConfig, saveConfig, DEFAULTS } from '../src/config.mjs';
import { createWallet, loadAccount, readAddress, proveControl } from '../src/keystore.mjs';
import { getNetwork, FAUCETS, TESTNET_DEMO_URL } from '../src/networks.mjs';
import { SafeWallet } from '../src/wallet.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const home = ensureHome(homeDir());
const wallet = () => new SafeWallet({ home });
const json = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `error: ${e.message || e}` }] });
const safe = (fn) => async (args) => { try { return json(await fn(args || {})); } catch (e) { return fail(e); } };

const server = new McpServer({ name: 'x402-safe-wallet', version: pkg.version });

server.registerTool('wallet_init', {
  description: 'Onboard: create a fresh dedicated wallet if none exists (key file mode 600 in a 700 directory, never shown), prove control with a signed message, and return the funding step for the human. Default network is Base Sepolia testnet.',
  inputSchema: {},
}, safe(async () => {
  if (!fs.existsSync(path.join(home, 'config.json'))) saveConfig(home, { ...DEFAULTS });
  const cfg = loadConfig(home);
  const existed = !!readAddress(cfg);
  const address = existed ? readAddress(cfg) : createWallet(cfg.keyFile);
  const proof = await proveControl(loadAccount(cfg));
  const net = getNetwork(cfg.network);
  return { created: !existed, address, controlProofValid: proof.valid, network: net.key, chainId: net.chainId, usdc: net.usdc,
    fundingStepForHuman: net.testnet
      ? { send: '1-10 testnet USDC (no real value)', faucets: FAUCETS, ethNeeded: false, next: `Human adds x402.org to allowHosts, then try x402_quote on ${TESTNET_DEMO_URL}` }
      : { send: `only the lifetime cap ($${cfg.lifetimeCapUsd}) in USDC on Base`, ethNeeded: 'optional, for the sweep' } };
}));

server.registerTool('balances', {
  description: 'Wallet address plus ETH and USDC balances on the configured network, and any extra ERC-20 token addresses given.',
  inputSchema: { tokens: z.array(z.string()).optional().describe('Extra ERC-20 token contract addresses') },
}, safe(({ tokens }) => wallet().balances(tokens || [])));

const reqShape = {
  url: z.string().describe('Full URL of the x402 resource'),
  method: z.string().optional().describe('HTTP method, default GET'),
  body: z.string().optional().describe('Request body (JSON string)'),
  maxUsd: z.number().optional().describe('Lower per-call cap for this call; can only lower the configured cap'),
};

server.registerTool('x402_quote', {
  description: 'Dry run. Sends the unpaid request, lists every payment option the seller offered, which one would be chosen (cheapest plain USDC EIP-3009 "exact" on this network) and whether the limits would allow it. Never signs or pays.',
  inputSchema: reqShape,
}, safe((a) => wallet().quote(a)));

server.registerTool('x402_pay', {
  description: 'Pay for one x402 request within the human-set limits: allowlisted hosts only, per-call/24h/lifetime caps, USDC floor, seller circuit breaker, top-up guard, and idempotency (the same request or the same idempotencyKey is never paid twice). One signed attempt, never retried. Returns DELIVERED, PAID_NOT_DELIVERED, REJECTED_UNPAID, UNKNOWN or REFUSED with a receiptId. On anything but DELIVERED: do not retry; tell the human and offer dispute_packet.',
  inputSchema: { ...reqShape,
    idempotencyKey: z.string().optional().describe('Unique key for this purchase. Reusing a key is refused. Pass a NEW key only when you intentionally buy the same request again.'),
    kind: z.enum(['request', 'topup']).optional().describe('Declare "topup" for prepaid credit purchases; top-ups need separate human approval in config') },
}, safe((a) => wallet().pay(a)));

server.registerTool('spend_status', {
  description: 'Current limits, spend in the last 24 hours and lifetime on this network, remaining budget, and sellers blocked by the circuit breaker.',
  inputSchema: {},
}, safe(async () => wallet().status()));

server.registerTool('receipts', {
  description: 'Recent entries from the append-only receipt log (payments, refusals, quotes, sweeps, breaker resets).',
  inputSchema: { limit: z.number().int().min(1).max(500).optional(), status: z.string().optional().describe('Filter, e.g. PAID_NOT_DELIVERED or REFUSED') },
}, safe(async (a) => wallet().receipts(a)));

server.registerTool('dispute_packet', {
  description: 'Bundle one payment receipt with its settlement tx (checked on-chain when possible), the request, the response, hashes and timestamps into a JSON file a human can send to the seller to ask for a refund. Does not contact anyone.',
  inputSchema: { receiptId: z.string() },
}, safe(({ receiptId }) => wallet().disputePacket(receiptId)));

await server.connect(new StdioServerTransport());
