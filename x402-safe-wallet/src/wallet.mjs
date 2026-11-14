// The guarded payment flow. Order of checks: network -> allowlist -> breaker -> top-up guard -> idempotency
// -> probe (unpaid) -> option choice -> payee pin -> caps -> balance floor -> sign once -> send once -> delivery check.
// Any failed check refuses BEFORE signing and is logged. After a signed payment is sent, nothing is retried.
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, http, erc20Abi, getAddress, formatEther, formatUnits } from 'viem';
import { loadConfig, ensureHome, homeDir, assertNetworkAllowed } from './config.mjs';
import { getNetwork } from './networks.mjs';
import { loadAccount, readAddress } from './keystore.mjs';
import { Ledger, STATUS, requestHash, sha256 } from './ledger.mjs';
import { parsePaymentRequired, chooseOption, signPayment, readSettlement } from './x402.mjs';

const TOPUP_RE = /(top-?up|credits?\b|deposit|prepaid|recharge|refill|add-?funds|fund-?account|balance\/add)/i;

export function hostAllowed(list, urlObj) {
  return list.some((h) => h === urlObj.host || h === urlObj.hostname);
}

export function looksLikeErrorBody(text) {
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object' && !Array.isArray(j) && (j.error || j.errors)) {
      return Object.keys(j).every((k) => ['error', 'errors', 'message', 'code', 'status', 'details', 'detail'].includes(k));
    }
  } catch {}
  return false;
}

function isEmptyBody(text) {
  const t = (text || '').trim();
  return t === '' || t === '{}' || t === '[]' || t === 'null' || t === '""';
}

export class SafeWallet {
  constructor(opts = {}) {
    this.home = ensureHome(homeDir(opts));
    this.cfg = opts.config || loadConfig(this.home);
    this.net = getNetwork(this.cfg.network);
    this.ledger = new Ledger(this.home);
    this.fetch = opts.fetch || globalThis.fetch;
    this._account = opts.account || null;
    this._balanceFn = opts.getUsdcBalance || null;
    this.now = opts.now || (() => Date.now());
  }
  account() { return (this._account ||= loadAccount(this.cfg)); }
  address() { return this._account?.address || readAddress(this.cfg); }
  publicClient() {
    return (this._pc ||= createPublicClient({ chain: this.net.chain, transport: http(this.cfg.rpcUrl || this.net.rpcUrl) }));
  }
  async usdcBalance() {
    if (this._balanceFn) return this._balanceFn();
    const raw = await this.publicClient().readContract({ address: this.net.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [this.address()] });
    return Number(raw) / 1e6;
  }

  async balances(tokens = []) {
    const pc = this.publicClient(); const addr = this.address();
    if (!addr) throw new Error('No wallet yet. Run "x402-safe-wallet init".');
    const eth = await pc.getBalance({ address: addr });
    const out = { network: this.net.key, address: addr, eth: formatEther(eth), usdc: String(await this.usdcBalance()), tokens: [] };
    for (const t of tokens) {
      const a = getAddress(t);
      const [bal, dec, sym] = await Promise.all([
        pc.readContract({ address: a, abi: erc20Abi, functionName: 'balanceOf', args: [addr] }),
        pc.readContract({ address: a, abi: erc20Abi, functionName: 'decimals' }),
        pc.readContract({ address: a, abi: erc20Abi, functionName: 'symbol' }).catch(() => '?'),
      ]);
      out.tokens.push({ address: a, symbol: sym, balance: formatUnits(bal, dec) });
    }
    return out;
  }

  status() {
    const t = this.ledger.totals(this.net.key, this.now());
    const c = this.cfg;
    return {
      network: this.net.key, testnet: this.net.testnet, address: this.address(),
      limits: { allowHosts: c.allowHosts, maxPerCallUsd: c.maxPerCallUsd, dailyCapUsd: c.dailyCapUsd, lifetimeCapUsd: c.lifetimeCapUsd,
        usdcFloorUsd: c.usdcFloorUsd, idempotencyWindowHours: c.idempotencyWindowHours, breakerThreshold: c.breakerThreshold, topups: c.topups },
      spent: t,
      remaining: { last24hUsd: Math.max(0, +(c.dailyCapUsd - t.last24hUsd).toFixed(6)), lifetimeUsd: Math.max(0, +(c.lifetimeCapUsd - t.lifetimeUsd).toFixed(6)) },
      blockedSellers: this.ledger.openBreakers(this.net.key, c.breakerThreshold),
    };
  }

  receipts({ limit = 20, status } = {}) {
    let all = this.ledger.all();
    if (status) all = all.filter((r) => r.status === status);
    return all.slice(-limit);
  }

  _refuse(base, code, reason) {
    const rec = this.ledger.append({ ...base, kind: 'pay', status: STATUS.REFUSED, code, reason });
    return { ok: false, paid: false, status: STATUS.REFUSED, code, reason, receiptId: rec.id };
  }

  // Shared pre-checks. Returns { base, ctx } or a refusal.
  _precheck(args) {
    const method = (args.method || 'GET').toUpperCase();
    const body = args.body == null ? undefined : typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
    let u; try { u = new URL(args.url); } catch { return { refusal: { ok: false, status: STATUS.REFUSED, code: 'BAD_URL', reason: 'url is not a valid absolute URL' } }; }
    const rHash = requestHash({ method, url: u.href, body });
    const base = { network: this.net.key, host: u.host, url: u.href, method, requestHash: rHash, idempotencyKey: args.idempotencyKey || null };
    try { assertNetworkAllowed(this.cfg); } catch (e) { return { refusal: this._refuse(base, e.code || 'NETWORK', e.message) }; }
    if (!['http:', 'https:'].includes(u.protocol)) return { refusal: this._refuse(base, 'BAD_URL', 'only http(s) URLs') };
    if (!hostAllowed(this.cfg.allowHosts, u)) return { refusal: this._refuse(base, 'HOST_NOT_ALLOWED', `host ${u.host} is not in allowHosts (a human must add it to config.json)`) };
    const br = this.ledger.breaker(this.net.key, u.host, this.cfg.breakerThreshold);
    if (br.open) return { refusal: this._refuse(base, 'SELLER_BLOCKED', `circuit breaker open for ${u.host} after paid-not-delivered receipt(s) ${br.trips.join(', ')}. A human must review and run "x402-safe-wallet breaker reset ${u.host}".`) };
    const topup = args.kind === 'topup' || TOPUP_RE.test(u.pathname + u.search) || (body ? TOPUP_RE.test(body.slice(0, 2000)) : false);
    if (topup && !hostAllowed(this.cfg.topups.allowHosts || [], u)) return { refusal: this._refuse({ ...base, topup }, 'TOPUP_NOT_ALLOWED', `this looks like a credit top-up to ${u.host}; top-ups need the host in topups.allowHosts`) };
    const prior = this.ledger.priorPayment(this.net.key, { idempotencyKey: args.idempotencyKey, requestHash: rHash }, this.cfg.idempotencyWindowHours);
    if (prior) return { refusal: this._refuse({ ...base, topup }, 'DUPLICATE', args.idempotencyKey
      ? `idempotency key already used for receipt ${prior.id} (${prior.status}); never paying twice for one key`
      : `same request already paid in receipt ${prior.id} (${prior.status}); pass a NEW idempotencyKey if you really mean to buy it again`) };
    return { base: { ...base, topup }, u, method, body };
  }

  async _probe(ctx, extraHeaders) {
    const init = { method: ctx.method, headers: { accept: 'application/json', ...(ctx.body ? { 'content-type': 'application/json' } : {}), ...(extraHeaders || {}) }, redirect: 'manual', signal: AbortSignal.timeout(this.cfg.requestTimeoutMs) };
    if (ctx.body !== undefined) init.body = ctx.body;
    const res = await this.fetch(ctx.u.href, init);
    return { res, init, text: await res.text() };
  }

  _capCheck(base, chosen, args) {
    const c = this.cfg; const usd = chosen.amountUsd;
    const perCall = Math.min(base.topup ? c.topups.maxPerCallUsd : c.maxPerCallUsd, args.maxUsd ?? Infinity);
    if (!(usd <= perCall)) return ['OVER_PER_CALL_CAP', `price $${usd} is above the per-call cap $${perCall}`];
    const t = this.ledger.totals(this.net.key, this.now());
    if (t.last24hUsd + usd > c.dailyCapUsd + 1e-9) return ['OVER_DAILY_CAP', `would bring 24h spend to $${(t.last24hUsd + usd).toFixed(6)} (cap $${c.dailyCapUsd})`];
    if (t.lifetimeUsd + usd > c.lifetimeCapUsd + 1e-9) return ['OVER_LIFETIME_CAP', `would bring lifetime spend to $${(t.lifetimeUsd + usd).toFixed(6)} (cap $${c.lifetimeCapUsd})`];
    if (base.topup && t.topupsLast24hUsd + usd > c.topups.dailyCapUsd + 1e-9) return ['OVER_TOPUP_DAILY_CAP', `top-ups would reach $${(t.topupsLast24hUsd + usd).toFixed(6)} in 24h (cap $${c.topups.dailyCapUsd})`];
    const pins = c.allowPayTo?.[base.host];
    if (pins && pins.length && !pins.map((p) => p.toLowerCase()).includes(String(chosen.payTo).toLowerCase())) return ['PAYTO_NOT_PINNED', `seller address ${chosen.payTo} is not in allowPayTo for ${base.host}`];
    return null;
  }

  // Dry run: shows what the seller offers and what would be chosen. Never signs.
  async quote(args) {
    const pre = this._precheck(args);
    if (pre.refusal) return pre.refusal;
    let probe; try { probe = await this._probe(pre); } catch (e) { return { ok: false, status: 'PROBE_FAILED', reason: String(e.message || e) }; }
    if (probe.res.status !== 402) return { ok: true, paymentRequired: false, httpStatus: probe.res.status, note: 'no payment asked for' };
    let pr; try { pr = parsePaymentRequired(probe.res.headers, probe.text); } catch (e) { return { ok: false, status: 'BAD_402', reason: e.message }; }
    const { classified, chosen } = chooseOption(pr, this.net);
    const capProblem = chosen ? this._capCheck(pre.base, chosen, args) : ['NO_USABLE_OPTION', 'no option is plain Base USDC EIP-3009 "exact" on this network'];
    const rec = this.ledger.append({ ...pre.base, kind: 'quote', status: STATUS.QUOTE, amountUsd: chosen?.amountUsd ?? null, payTo: chosen?.payTo ?? null, wouldPay: !capProblem, code: capProblem?.[0] || null });
    return { ok: true, paymentRequired: true, x402Version: pr.x402Version, resource: pr.resource || null, options: classified,
      chosen: chosen ? { index: chosen.index, amountUsd: chosen.amountUsd, payTo: chosen.payTo, network: chosen.network } : null,
      wouldPay: !capProblem, wouldRefuse: capProblem ? { code: capProblem[0], reason: capProblem[1] } : null, receiptId: rec.id };
  }

  async pay(args) {
    const pre = this._precheck(args);
    if (pre.refusal) return pre.refusal;
    const { base } = pre;
    let probe; try { probe = await this._probe(pre); } catch (e) { return this._refuse(base, 'PROBE_FAILED', `unpaid probe failed: ${e.message}`); }
    if (probe.res.status !== 402) return { ok: probe.res.ok, paid: false, httpStatus: probe.res.status, body: probe.text.slice(0, this.cfg.maxResponseBytes), note: 'no payment was asked for, so nothing was paid' };
    let pr; try { pr = parsePaymentRequired(probe.res.headers, probe.text); } catch (e) { return this._refuse(base, 'BAD_402', e.message); }
    const desc = `${pr.resource?.url || ''} ${pr.resource?.description || ''}`;
    if (!base.topup && TOPUP_RE.test(desc) && !hostAllowed(this.cfg.topups.allowHosts || [], pre.u)) return this._refuse({ ...base, topup: true }, 'TOPUP_NOT_ALLOWED', 'the 402 describes a credit top-up; top-ups need the host in topups.allowHosts');
    const { chosen } = chooseOption(pr, this.net);
    if (!chosen) return this._refuse(base, 'NO_USABLE_OPTION', 'no option is plain USDC EIP-3009 "exact" on this network');
    const capProblem = this._capCheck(base, chosen, args);
    if (capProblem) return this._refuse({ ...base, amountUsd: chosen.amountUsd, payTo: chosen.payTo }, ...capProblem);
    let bal; try { bal = await this.usdcBalance(); } catch (e) { return this._refuse(base, 'BALANCE_UNKNOWN', `could not read USDC balance, failing closed: ${e.message}`); }
    if (bal < chosen.amountUsd) return this._refuse({ ...base, amountUsd: chosen.amountUsd }, 'INSUFFICIENT_FUNDS', `USDC balance $${bal} is below the price $${chosen.amountUsd}; fund the wallet (see "fund")`);
    if (bal - chosen.amountUsd < this.cfg.usdcFloorUsd - 1e-9) return this._refuse({ ...base, amountUsd: chosen.amountUsd }, 'BELOW_FLOOR', `balance $${bal} minus $${chosen.amountUsd} would go below the floor $${this.cfg.usdcFloorUsd}`);

    const signed = await signPayment(this.account(), pr, chosen.requirement, this.net, Math.floor(this.now() / 1000));
    const payBase = { ...base, amountUsd: chosen.amountUsd, amountAtomic: chosen.amountAtomic, payTo: chosen.payTo, asset: chosen.requirement.asset,
      scheme: 'exact', optionNetwork: chosen.network, nonce: signed.authorization.nonce, validBefore: signed.authorization.validBefore,
      request: { method: pre.method, url: pre.u.href, body: pre.body ?? null } };
    const t0 = this.now();
    let res, text = '', fetchError = null;
    try {
      const r = await this._probe(pre, { [signed.header]: signed.value });
      res = r.res; text = r.text;
    } catch (e) { fetchError = String(e.message || e); }
    const ms = this.now() - t0;
    if (fetchError) {
      const rec = this.ledger.append({ ...payBase, kind: 'pay', status: STATUS.UNKNOWN, reason: `signed payment sent, no response: ${fetchError}. Not retrying. Check the chain before doing anything else.`, ms });
      return { ok: false, paid: 'unknown', status: STATUS.UNKNOWN, reason: rec.reason, receiptId: rec.id };
    }
    const settlement = readSettlement(res.headers);
    const bytes = Buffer.byteLength(text);
    const http = { status: res.status, bytes, sha256: sha256(text), contentType: res.headers.get('content-type') };
    let status, reason = null;
    if (res.status >= 200 && res.status < 300) {
      if (isEmptyBody(text)) { status = STATUS.PAID_NOT_DELIVERED; reason = 'seller returned an empty body after payment'; }
      else if (looksLikeErrorBody(text)) { status = STATUS.PAID_NOT_DELIVERED; reason = 'seller returned an error body after payment'; }
      else status = STATUS.DELIVERED;
    } else if (settlement?.success === true) { status = STATUS.PAID_NOT_DELIVERED; reason = `seller settled the payment but answered HTTP ${res.status}`; }
    else if (settlement?.success === false || res.status === 402) { status = STATUS.REJECTED_UNPAID; reason = `seller rejected the signed payment (HTTP ${res.status}); not retrying. The signature stays valid until ${new Date(Number(signed.authorization.validBefore) * 1000).toISOString()}, so it counts toward your caps (conservative).`; }
    else { status = STATUS.UNKNOWN; reason = `HTTP ${res.status} with no settlement info; not retrying. Check the chain.`; }
    const rec = this.ledger.append({ ...payBase, kind: 'pay', status, reason, http, settlement, ms });
    fs.writeFileSync(path.join(this.home, 'responses', `${rec.id}.body`), text, { mode: 0o600 });
    const ok = status === STATUS.DELIVERED;
    return { ok, paid: status === STATUS.REJECTED_UNPAID ? false : status === STATUS.UNKNOWN ? 'unknown' : true, status, reason, receiptId: rec.id,
      amountUsd: chosen.amountUsd, settlementTx: settlement?.transaction || null, httpStatus: res.status, bytes,
      body: ok ? text.slice(0, this.cfg.maxResponseBytes) : text.slice(0, 2000),
      next: ok ? null : 'Do not retry. A human can use dispute_packet with this receiptId to ask the seller for a refund.' };
  }

  // Bundles everything a buyer needs to ask a seller for a refund. Optionally checks the tx on-chain.
  async disputePacket(receiptId, { checkChain = true } = {}) {
    const rec = this.ledger.find(receiptId);
    if (!rec || rec.kind !== 'pay') throw new Error(`No payment receipt ${receiptId}`);
    const bodyFile = path.join(this.home, 'responses', `${rec.id}.body`);
    const response = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8') : null;
    let chain = null;
    const tx = rec.settlement?.transaction;
    if (checkChain && tx && /^0x[0-9a-fA-F]{64}$/.test(tx)) {
      try {
        const r = await this.publicClient().getTransactionReceipt({ hash: tx });
        chain = { status: r.status, blockNumber: r.blockNumber.toString(), explorer: `${this.net.explorer}/tx/${tx}` };
      } catch (e) { chain = { error: `could not read tx: ${e.shortMessage || e.message}` }; }
    }
    const packet = {
      generatedAt: new Date().toISOString(),
      summary: `Paid ${rec.amountUsd} USDC on ${rec.network} to ${rec.payTo} for ${rec.method} ${rec.url}; result ${rec.status}${rec.reason ? `: ${rec.reason}` : ''}.`,
      receipt: rec,
      buyer: rec.request ? this.address() : null,
      settlementTx: tx || null, chain,
      request: rec.request || null,
      response: response == null ? null : { httpStatus: rec.http?.status, bytes: rec.http?.bytes, sha256: rec.http?.sha256, contentType: rec.http?.contentType, bodyExcerpt: response.slice(0, 4000) },
      ask: 'The payment above settled (or may have settled) but the service was not delivered as paid for. Please refund the amount to the payer address, or deliver the response.',
    };
    const out = path.join(this.home, 'disputes', `${rec.id}.json`);
    fs.writeFileSync(out, JSON.stringify(packet, null, 2), { mode: 0o600 });
    return { file: out, packet };
  }

  breakerReset(host, note = '') {
    return this.ledger.append({ kind: 'breaker_reset', network: this.net.key, host, note });
  }

  // Kill switch: move all USDC, then all ETH (minus gas), to config.sweepTo. Needs confirm: true.
  async sweep({ confirm = false } = {}) {
    if (!this.cfg.sweepTo) throw new Error('Set "sweepTo" in config.json to an address you control first.');
    const to = getAddress(this.cfg.sweepTo);
    const addr = this.address();
    const pc = this.publicClient();
    const usdcRaw = await pc.readContract({ address: this.net.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [addr] });
    const plan = { network: this.net.key, from: addr, to, usdc: formatUnits(usdcRaw, 6), eth: formatEther(await pc.getBalance({ address: addr })) };
    if (!confirm) return { dryRun: true, plan, note: 'Nothing moved. Re-run with --confirm to sweep.' };
    const wc = createWalletClient({ account: this.account(), chain: this.net.chain, transport: http(this.cfg.rpcUrl || this.net.rpcUrl) });
    const txs = [];
    if (usdcRaw > 0n) {
      const h = await wc.writeContract({ address: this.net.usdc, abi: erc20Abi, functionName: 'transfer', args: [to, usdcRaw] });
      await pc.waitForTransactionReceipt({ hash: h }); txs.push({ asset: 'USDC', amount: formatUnits(usdcRaw, 6), tx: h });
    }
    const ethBal = await pc.getBalance({ address: addr });
    const fees = await pc.estimateFeesPerGas();
    const gasCost = 21000n * (fees.maxFeePerGas ?? fees.gasPrice) * 3n + 10_000_000_000_000n; // L2 gas x3 plus 0.00001 ETH for the L1 data fee
    if (ethBal > gasCost) {
      const value = ethBal - gasCost;
      const h = await wc.sendTransaction({ to, value, gas: 21000n });
      await pc.waitForTransactionReceipt({ hash: h }); txs.push({ asset: 'ETH', amount: formatEther(value), tx: h });
    }
    this.ledger.append({ kind: 'sweep', network: this.net.key, to, txs });
    return { dryRun: false, plan, txs, note: txs.length ? 'Swept.' : 'Nothing to sweep (USDC sweep needs a little ETH for gas).' };
  }
}
