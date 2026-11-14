#!/usr/bin/env node
// A small local x402 seller for testing buyers without real money.
// It speaks x402 v2 "exact" on Base Sepolia: answers 402 with a PAYMENT-REQUIRED header, checks the
// buyer's EIP-3009 signature, and then either simulates settlement (default, no chain, no funds) or,
// with --facilitator https://x402.org/facilitator, asks a real facilitator to verify and settle on Base Sepolia.
//
// Routes (price in testnet USDC):
//   /paid           $0.01  delivers JSON
//   /empty          $0.01  settles, then returns an empty 200 (paid, not delivered)
//   /error          $0.01  settles, then returns HTTP 500 (paid, not delivered)
//   /reject         $0.01  rejects the signed payment with 402 (like a "Verification error")
//   /expensive      $0.50  delivers JSON (to test the per-call cap)
//   /credits/topup  $0.02  a credit top-up (to test the top-up guard)
//   /multi          several payment options, only some usable (to test option choice)
import http from 'node:http';
import { verifyTypedData, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { NETWORKS } from '../src/networks.mjs';
import { twaTypedData, decodeB64Json, encodeB64Json } from '../src/x402.mjs';

const NET = NETWORKS['base-sepolia'];

function req(payTo, usd, extra = {}) {
  return { scheme: 'exact', network: NET.caip2, amount: String(Math.round(usd * 1e6)), asset: NET.usdc, payTo, maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' }, ...extra };
}

function routeTable(payTo) {
  return {
    '/paid': { accepts: [req(payTo, 0.01)], deliver: () => [200, JSON.stringify({ data: 'the thing you paid for', at: new Date().toISOString() })] },
    '/empty': { accepts: [req(payTo, 0.01)], deliver: () => [200, ''] },
    '/error': { accepts: [req(payTo, 0.01)], deliver: () => [500, JSON.stringify({ error: 'upstream quota exceeded' })] },
    '/reject': { accepts: [req(payTo, 0.01)], reject: true },
    '/expensive': { accepts: [req(payTo, 0.5)], deliver: () => [200, JSON.stringify({ data: 'pricey' })] },
    '/credits/topup': { accepts: [req(payTo, 0.02)], deliver: () => [200, JSON.stringify({ credits: 2 })] },
    '/multi': {
      accepts: [
        { ...req(payTo, 0.001), network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', payTo: 'So11111111111111111111111111111111111111112' },
        req(payTo, 0.002, { extra: { name: 'USDC', version: '2', assetTransferMethod: 'permit2' } }),
        { ...req(payTo, 0.0005), scheme: 'upto' },
        req(payTo, 0.03),
        req(payTo, 0.02),
      ],
      deliver: () => [200, JSON.stringify({ data: 'multi ok' })],
    },
  };
}

async function verifyLocally(payload, accepts) {
  const acc = payload.accepted;
  const match = accepts.find((a) => a.scheme === acc?.scheme && a.network === acc?.network && a.amount === acc?.amount && a.payTo === acc?.payTo && a.asset === acc?.asset);
  if (!match || match.scheme !== 'exact' || match.network !== NET.caip2) return 'accepted option does not match an offered exact Base Sepolia option';
  const { authorization: a, signature } = payload.payload || {};
  if (!a || !signature) return 'missing authorization';
  if (getAddress(a.to) !== getAddress(match.payTo) || a.value !== match.amount) return 'authorization does not match price or payTo';
  if (Number(a.validBefore) <= Math.floor(Date.now() / 1000)) return 'authorization expired';
  const td = twaTypedData(match, NET, a);
  const ok = await verifyTypedData({ address: a.from, ...td, signature });
  return ok ? null : 'bad signature';
}

async function facilitatorCall(url, path, payload, requirement) {
  const r = await fetch(`${url.replace(/\/$/, '')}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x402Version: payload.x402Version, paymentPayload: payload, paymentRequirements: requirement }) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

export function startMockSeller({ port = 4021, payTo, facilitator = null, log = () => {} } = {}) {
  const seller = payTo ? getAddress(payTo) : privateKeyToAccount(generatePrivateKey()).address;
  const routes = routeTable(seller);
  const calls = { settled: 0, requests: 0 };
  const server = http.createServer(async (rq, rs) => {
    calls.requests++;
    const u = new URL(rq.url, 'http://localhost');
    const route = routes[u.pathname];
    if (!route) { rs.writeHead(404); return rs.end('not found'); }
    const resource = { url: `http://${rq.headers.host}${u.pathname}`, description: u.pathname === '/credits/topup' ? 'Buy prepaid credits' : 'Mock x402 resource', mimeType: 'application/json' };
    const pr = { x402Version: 2, error: 'Payment required', resource, accepts: route.accepts };
    const sig = rq.headers['payment-signature'];
    if (!sig) { rs.writeHead(402, { 'content-type': 'application/json', 'payment-required': encodeB64Json(pr) }); return rs.end(JSON.stringify(pr)); }
    let payload; try { payload = decodeB64Json(sig); } catch { rs.writeHead(400); return rs.end('bad payment header'); }
    if (route.reject) { rs.writeHead(402, { 'content-type': 'application/json', 'payment-required': encodeB64Json({ ...pr, error: 'Verification error' }) }); return rs.end(JSON.stringify({ error: 'Verification error' })); }
    let settlement;
    if (facilitator) {
      const v = await facilitatorCall(facilitator, 'verify', payload, payload.accepted);
      log('facilitator verify', v.status, JSON.stringify(v.json));
      if (!v.json?.isValid) { rs.writeHead(402, { 'content-type': 'application/json' }); return rs.end(JSON.stringify({ error: 'verify failed', detail: v.json })); }
      const s = await facilitatorCall(facilitator, 'settle', payload, payload.accepted);
      log('facilitator settle', s.status, JSON.stringify(s.json));
      if (!s.json?.success) { rs.writeHead(402, { 'content-type': 'application/json', 'payment-response': encodeB64Json(s.json || { success: false }) }); return rs.end(JSON.stringify({ error: 'settle failed', detail: s.json })); }
      settlement = s.json;
    } else {
      const err = await verifyLocally(payload, route.accepts);
      if (err) { rs.writeHead(402, { 'content-type': 'application/json', 'payment-response': encodeB64Json({ success: false, errorReason: err }) }); return rs.end(JSON.stringify({ error: err })); }
      settlement = { success: true, transaction: 'simulated-no-chain', network: NET.caip2, payer: payload.payload.authorization.from, simulated: true };
    }
    calls.settled++;
    const [code, body] = route.deliver();
    rs.writeHead(code, { 'content-type': 'application/json', 'payment-response': encodeB64Json(settlement) });
    rs.end(body);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, payTo: seller, calls, close: () => new Promise((r) => server.close(r)) })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const s = await startMockSeller({ port: Number(arg('--port') || 4021), payTo: arg('--pay-to'), facilitator: arg('--facilitator'), log: console.log });
  console.log(`mock x402 seller on http://127.0.0.1:${s.port} (payTo ${s.payTo}, ${arg('--facilitator') ? `real settlement via ${arg('--facilitator')}` : 'simulated settlement, no chain'})`);
  console.log('routes: /paid /empty /error /reject /expensive /credits/topup /multi');
}
