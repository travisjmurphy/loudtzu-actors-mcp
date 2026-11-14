// Runs entirely offline against the bundled mock seller. No funds, no chain, no network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { SafeWallet } from '../src/wallet.mjs';
import { DEFAULTS, MAINNET_CONFIRM_PHRASE, ensureHome, loadConfig, saveConfig } from '../src/config.mjs';
import { createWallet, loadAccount, proveControl } from '../src/keystore.mjs';
import { startMockSeller } from '../examples/mock-seller.mjs';

let seller, base;
before(async () => { seller = await startMockSeller({ port: 0 }); base = `http://127.0.0.1:${seller.port}`; });
after(async () => { await seller.close(); });

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'x402sw-')); }
function wallet(over = {}, opts = {}) {
  const home = opts.home || tmpHome();
  const config = { ...DEFAULTS, keyFile: path.join(home, 'key.json'), allowHosts: [`127.0.0.1:${seller.port}`], ...over, topups: { ...DEFAULTS.topups, ...(over.topups || {}) } };
  return new SafeWallet({ home, config, account: privateKeyToAccount(generatePrivateKey()), getUsdcBalance: async () => opts.balance ?? 10 });
}

test('onboard: init writes a 600 key in a 700 dir with a .gitignore, and control proof verifies', async () => {
  const home = ensureHome(path.join(tmpHome(), 'w'));
  const cfg = loadConfig(home);
  const addr = createWallet(cfg.keyFile);
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.equal(fs.statSync(cfg.keyFile).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(path.join(home, '.gitignore'), 'utf8'), /^\*$/m);
  assert.throws(() => createWallet(cfg.keyFile), /Refusing to overwrite/);
  const proof = await proveControl(loadAccount(cfg));
  assert.equal(proof.address, addr); assert.equal(proof.valid, true);
  fs.chmodSync(cfg.keyFile, 0o644);
  assert.throws(() => loadAccount(cfg), /readable by other users/);
});

test('default network is Base Sepolia; mainnet refuses without the confirm phrase', async () => {
  assert.equal(DEFAULTS.network, 'base-sepolia');
  const w = wallet({ network: 'base' });
  const r = await w.pay({ url: `${base}/paid` });
  assert.equal(r.code, 'MAINNET_NOT_CONFIRMED');
  const w2 = wallet({ network: 'base', confirmMainnet: MAINNET_CONFIRM_PHRASE });
  const r2 = await w2.quote({ url: `${base}/paid` });
  assert.equal(r2.chosen, null, 'testnet-only seller offers nothing usable on mainnet');
});

test('allowlist is empty by default, so nothing can be paid', async () => {
  const w = wallet({ allowHosts: [] });
  const r = await w.pay({ url: `${base}/paid` });
  assert.equal(r.code, 'HOST_NOT_ALLOWED'); assert.equal(seller.calls.settled >= 0, true);
});

test('happy path: pays once, DELIVERED, receipt has hash, size and settlement', async () => {
  const w = wallet();
  const r = await w.pay({ url: `${base}/paid`, method: 'POST', body: { q: 1 } });
  assert.equal(r.status, 'DELIVERED'); assert.equal(r.amountUsd, 0.01);
  const rec = w.ledger.find(r.receiptId);
  assert.equal(rec.http.status, 200); assert.ok(rec.http.bytes > 0); assert.match(rec.http.sha256, /^[0-9a-f]{64}$/);
  assert.equal(rec.settlement.success, true);
  assert.equal(w.status().spent.lifetimeUsd, 0.01);
});

test('idempotency: same request is refused without a new key; a used key is never paid twice', async () => {
  const w = wallet();
  const before = seller.calls.settled;
  assert.equal((await w.pay({ url: `${base}/paid?x=1` })).status, 'DELIVERED');
  const dup = await w.pay({ url: `${base}/paid?x=1` });
  assert.equal(dup.code, 'DUPLICATE');
  assert.equal((await w.pay({ url: `${base}/paid?x=1`, idempotencyKey: 'k-1' })).status, 'DELIVERED');
  assert.equal((await w.pay({ url: `${base}/paid?x=2`, idempotencyKey: 'k-1' })).code, 'DUPLICATE');
  assert.equal(seller.calls.settled - before, 2);
});

test('fail-closed: empty body after payment is PAID_NOT_DELIVERED, breaker blocks the seller, no retry', async () => {
  const w = wallet();
  const before = seller.calls.requests;
  const r = await w.pay({ url: `${base}/empty` });
  assert.equal(r.status, 'PAID_NOT_DELIVERED'); assert.equal(r.paid, true);
  assert.equal(seller.calls.requests - before, 2, 'one unpaid probe + one paid call, never a retry');
  const blocked = await w.pay({ url: `${base}/paid?after-empty` });
  assert.equal(blocked.code, 'SELLER_BLOCKED');
  assert.equal(w.status().blockedSellers.length, 1);
  w.breakerReset(`127.0.0.1:${seller.port}`, 'reviewed by human');
  assert.equal((await w.pay({ url: `${base}/paid?after-reset` })).status, 'DELIVERED');
});

test('HTTP 500 after settlement is PAID_NOT_DELIVERED and gets a dispute packet', async () => {
  const w = wallet();
  const r = await w.pay({ url: `${base}/error`, method: 'POST', body: '{"job":42}' });
  assert.equal(r.status, 'PAID_NOT_DELIVERED');
  const { file, packet } = await w.disputePacket(r.receiptId, { checkChain: false });
  assert.ok(fs.existsSync(file));
  assert.equal(packet.request.body, '{"job":42}');
  assert.equal(packet.response.httpStatus, 500);
  assert.match(packet.response.bodyExcerpt, /quota/);
  assert.equal(packet.settlementTx, 'simulated-no-chain');
});

test('seller rejection (402 after signing) is REJECTED_UNPAID and is not retried', async () => {
  const w = wallet();
  const before = seller.calls.requests;
  const r = await w.pay({ url: `${base}/reject` });
  assert.equal(r.status, 'REJECTED_UNPAID'); assert.equal(r.paid, false);
  assert.equal(seller.calls.requests - before, 2);
  assert.equal((await w.pay({ url: `${base}/reject` })).code, 'DUPLICATE');
});

test('caps: per-call, maxUsd argument, daily and lifetime', async () => {
  assert.equal((await wallet().pay({ url: `${base}/expensive` })).code, 'OVER_PER_CALL_CAP');
  assert.equal((await wallet().pay({ url: `${base}/paid`, maxUsd: 0.005 })).code, 'OVER_PER_CALL_CAP');
  const d = wallet({ dailyCapUsd: 0.015 });
  assert.equal((await d.pay({ url: `${base}/paid?a` })).status, 'DELIVERED');
  assert.equal((await d.pay({ url: `${base}/paid?b` })).code, 'OVER_DAILY_CAP');
  const l = wallet({ lifetimeCapUsd: 0.01 });
  assert.equal((await l.pay({ url: `${base}/paid?a` })).status, 'DELIVERED');
  assert.equal((await l.pay({ url: `${base}/paid?b` })).code, 'OVER_LIFETIME_CAP');
});

test('USDC floor refuses, and an unreadable balance fails closed', async () => {
  assert.equal((await wallet({ usdcFloorUsd: 1 }, { balance: 1.005 }).pay({ url: `${base}/paid` })).code, 'BELOW_FLOOR');
  assert.equal((await wallet({}, { balance: 0 }).pay({ url: `${base}/paid` })).code, 'INSUFFICIENT_FUNDS');
  const home = tmpHome();
  const w = new SafeWallet({ home, config: { ...DEFAULTS, keyFile: path.join(home, 'k'), allowHosts: [`127.0.0.1:${seller.port}`] }, account: privateKeyToAccount(generatePrivateKey()), getUsdcBalance: async () => { throw new Error('rpc down'); } });
  assert.equal((await w.pay({ url: `${base}/paid` })).code, 'BALANCE_UNKNOWN');
});

test('top-up guard: refused unless the host is in topups.allowHosts, then capped daily', async () => {
  assert.equal((await wallet().pay({ url: `${base}/credits/topup` })).code, 'TOPUP_NOT_ALLOWED');
  const host = `127.0.0.1:${seller.port}`;
  const w = wallet({ topups: { allowHosts: [host], maxPerCallUsd: 0.05, dailyCapUsd: 0.03 } });
  assert.equal((await w.pay({ url: `${base}/credits/topup` })).status, 'DELIVERED');
  assert.equal((await w.pay({ url: `${base}/credits/topup`, idempotencyKey: 'second' })).code, 'OVER_TOPUP_DAILY_CAP');
});

test('quote picks the cheapest usable option and explains the rest, without signing', async () => {
  const w = wallet();
  const before = seller.calls.settled;
  const q = await w.quote({ url: `${base}/multi` });
  assert.equal(q.chosen.amountUsd, 0.02);
  assert.equal(q.options.filter((o) => o.usable).length, 2);
  assert.ok(q.options.find((o) => o.rejectedBecause.some((x) => x.includes('permit2'))));
  assert.ok(q.options.find((o) => o.rejectedBecause.some((x) => x.includes('upto'))));
  assert.equal(seller.calls.settled, before);
  assert.equal((await w.pay({ url: `${base}/multi` })).amountUsd, 0.02);
});

test('payee pinning refuses an unexpected seller address', async () => {
  const w = wallet({ allowPayTo: { [`127.0.0.1:${seller.port}`]: ['0x000000000000000000000000000000000000dEaD'] } });
  assert.equal((await w.pay({ url: `${base}/paid` })).code, 'PAYTO_NOT_PINNED');
});

test('receipts are append-only JSONL with mode 600 and never contain the key', async () => {
  const home = tmpHome(); ensureHome(home);
  const pk = generatePrivateKey();
  const w = new SafeWallet({ home, config: { ...DEFAULTS, keyFile: path.join(home, 'k'), allowHosts: [`127.0.0.1:${seller.port}`] }, account: privateKeyToAccount(pk), getUsdcBalance: async () => 10 });
  await w.pay({ url: `${base}/paid` }); await w.pay({ url: `${base}/expensive` });
  const f = path.join(home, 'receipts.jsonl');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const txt = fs.readFileSync(f, 'utf8');
  assert.equal(txt.trim().split('\n').length, 2);
  assert.ok(!txt.includes(pk.slice(2)), 'private key must never be written to receipts');
  for (const dir of ['responses', 'disputes']) for (const n of fs.readdirSync(path.join(home, dir))) assert.ok(!fs.readFileSync(path.join(home, dir, n), 'utf8').includes(pk.slice(2)));
});

test('saveConfig + loadConfig round-trip keeps safe defaults', () => {
  const home = ensureHome(tmpHome());
  saveConfig(home, { ...loadConfig(home), allowHosts: ['x402.org'] });
  const c = loadConfig(home);
  assert.deepEqual(c.allowHosts, ['x402.org']); assert.equal(c.maxPerCallUsd, 0.05); assert.equal(c.dailyCapUsd, 1); assert.equal(c.network, 'base-sepolia');
});
