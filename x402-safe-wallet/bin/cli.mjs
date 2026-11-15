#!/usr/bin/env node
// x402-safe-wallet CLI. Stages: onboard -> test -> build -> spend.
import fs from 'node:fs';
import path from 'node:path';
import { homeDir, ensureHome, loadConfig, saveConfig, DEFAULTS, MAINNET_CONFIRM_PHRASE } from '../src/config.mjs';
import { createWallet, loadAccount, readAddress, proveControl } from '../src/keystore.mjs';
import { getNetwork, FAUCETS, TESTNET_DEMO_URL } from '../src/networks.mjs';
import { SafeWallet } from '../src/wallet.mjs';

const HELP = `x402-safe-wallet: a dedicated, capped wallet for bots that pay x402 APIs.
Default network: Base Sepolia (testnet, no real money).

Onboard
  init                     create a fresh wallet (key in a 700 dir, file mode 600) and prove control
  prove                    sign and verify a control-proof message
  fund                     show the funding step for the human (address, amount, network, faucets)
  balances [--token 0x..]  ETH, USDC and any other ERC-20 you name
Test and build
  try                      one-shot Base Sepolia demo: init if needed, pay the public x402.org demo, print the tx hash
  demo                     offline demo against the bundled mock seller (no funds, no chain)
  quote <url>              dry run: what the seller offers and what would be chosen (never signs)
  pay <url>                guarded payment (testnet unless the human enabled mainnet)
     [--method POST] [--body '{"json":1}'] [--max-usd 0.01] [--key <idempotency key>] [--topup]
Spend controls
  status                   limits, spend in the last 24h and lifetime, blocked sellers
  receipts [--limit 20] [--status PAID_NOT_DELIVERED]
  dispute <receiptId>      write a refund-request packet (receipt, tx, request, response, times)
  breaker reset <host>     human-only: unblock a seller after review
  config show | allow <host> | disallow <host> | set <key> <json-value>
  sweep [--confirm]        kill switch: move all USDC and ETH to config.sweepTo
MCP
  mcp                      run the MCP server on stdio

Options: --home <dir> (or X402SW_HOME). Key: <home>/key.json or X402SW_PRIVATE_KEY. The key is never printed.
Unaudited. Experimental. You risk your own funds. Use a dedicated wallet holding only what you can lose.`;

const argv = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); const nx = argv[i + 1]; if (nx === undefined || nx.startsWith('--')) flags[k] = true; else { flags[k] = flags[k] ? [].concat(flags[k], nx) : nx; i++; } }
  else pos.push(a);
}
const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));
const home = () => ensureHome(homeDir({ home: flags.home }));

function fundingGuide(cfg, address) {
  const net = getNetwork(cfg.network);
  const lines = [
    '', `FUNDING STEP (for the human in charge of this bot)`,
    `  Address : ${address}`,
    `  Network : ${net.testnet ? 'Base Sepolia testnet' : 'Base mainnet'} (chain id ${net.chainId})`,
    `  Token   : USDC ${net.usdc}`,
  ];
  if (net.testnet) {
    lines.push(`  Amount  : 1 to 10 testnet USDC is plenty. Testnet tokens have no value.`, `  Faucets :`);
    for (const f of FAUCETS) lines.push(`    - ${f.name}: ${f.url}`);
    lines.push(`  ETH     : not needed for x402 payments (the seller's facilitator pays gas). Get a little testnet ETH only if you want to test the sweep.`);
    lines.push(`  Then    : x402-safe-wallet config allow x402.org && x402-safe-wallet quote ${TESTNET_DEMO_URL} && x402-safe-wallet pay ${TESTNET_DEMO_URL} --max-usd 0.01`);
  } else {
    lines.push(`  Amount  : send ONLY your lifetime cap ($${cfg.lifetimeCapUsd} USDC) or less. This wallet should never hold more than you can lose.`,
      `  ETH     : optional, about $0.10 of ETH on Base so the sweep (kill switch) can pay gas. x402 payments themselves are gasless for the buyer.`,
      `  Check   : x402-safe-wallet balances`);
  }
  lines.push(`  Explorer: ${net.explorer}/address/${address}`, '');
  return lines.join('\n');
}

async function runTry() {
  const h = home();
  if (!fs.existsSync(path.join(h, 'config.json'))) saveConfig(h, { ...DEFAULTS });
  const cfg = loadConfig(h);
  const net = getNetwork(cfg.network);
  if (!net.testnet) {
    throw new Error('try is Base Sepolia (testnet) only and will not run against mainnet. Use a separate testnet home (X402SW_HOME or --home) if this one is set to base.');
  }
  let address = readAddress(cfg);
  if (!address) {
    address = createWallet(cfg.keyFile);
    out(`Created a fresh dedicated wallet in ${h}\n  key file ${cfg.keyFile} (mode 600, directory mode 700, .gitignore '*')`);
    const proof = await proveControl(loadAccount(cfg));
    fs.writeFileSync(path.join(h, 'control-proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
    out(`Control proof: signed and verified a message with this key (${proof.valid ? 'VALID' : 'INVALID'}). Saved to control-proof.json.`);
  } else {
    out(`Using the existing wallet in ${h}: ${address}`);
  }
  // Allow the public demo for this call only. Never write it to the saved allowlist.
  const liveCfg = { ...cfg, allowHosts: [...new Set([...cfg.allowHosts, 'x402.org'])] };
  const w = new SafeWallet({ home: h, config: liveCfg });
  const price = 0.01;
  let bal;
  try { bal = await w.usdcBalance(); } catch (e) {
    throw new Error(`could not read USDC balance, failing closed: ${e.message}`);
  }
  if (bal < price) {
    out(`No testnet USDC yet (balance $${bal}). Get 1 USDC on Base Sepolia from ${FAUCETS[0].url} for address ${address}, then run the same command again.`);
    process.exitCode = 2;
    return;
  }
  const r = await w.pay({ url: TESTNET_DEMO_URL, maxUsd: price, idempotencyKey: flags.key || undefined });
  // On a duplicate, pay() records a new REFUSED receipt; the settlement tx lives on the prior payment named in the reason.
  let rec = r.receiptId ? w.ledger.find(r.receiptId) : null;
  if (r.code === 'DUPLICATE' && typeof r.reason === 'string') {
    const m = r.reason.match(/receipt (r_[a-z0-9]+_[a-f0-9]+)/i);
    if (m) rec = w.ledger.find(m[1]) || rec;
  }
  const tx = r.settlementTx || rec?.settlement?.transaction || null;
  const summary = {
    ok: Boolean(r.ok || (r.code === 'DUPLICATE' && tx)),
    paid: r.code === 'DUPLICATE' ? true : r.paid,
    status: r.code === 'DUPLICATE' ? 'ALREADY_PAID' : r.status,
    reason: r.reason || null,
    receiptId: rec?.id || r.receiptId || null,
    amountUsd: r.amountUsd ?? rec?.amountUsd ?? price,
    settlementTx: tx,
    explorer: tx ? `${net.explorer}/tx/${tx}` : null,
    httpStatus: r.httpStatus ?? rec?.http?.status ?? null,
  };
  out(summary);
  if (tx) {
    // Last line is the bare hash, so a first run ends by printing the tx hash.
    console.log(tx);
    process.exitCode = 0;
    return;
  }
  process.exitCode = 3;
}

async function main() {
  const cmd = pos[0];
  if (!cmd || flags.help || cmd === 'help') return out(HELP);
  if (cmd === 'mcp') { await import('./mcp.mjs'); return; }
  if (cmd === 'demo') { const { runDemo } = await import('../examples/demo.mjs'); return runDemo(); }
  if (cmd === 'try' || cmd === 'quickstart') return runTry();

  const h = home();
  if (cmd === 'init') {
    if (!fs.existsSync(path.join(h, 'config.json'))) saveConfig(h, { ...DEFAULTS });
    const cfg = loadConfig(h);
    if (flags.network) { cfg.network = flags.network; getNetwork(cfg.network); saveConfig(h, cfg); }
    let address = readAddress(cfg);
    if (address) out(`A wallet already exists in ${h}: ${address} (not overwritten).`);
    else { address = createWallet(cfg.keyFile); out(`Created a fresh dedicated wallet in ${h}\n  key file ${cfg.keyFile} (mode 600, directory mode 700, .gitignore '*')`); }
    const proof = await proveControl(loadAccount(cfg));
    fs.writeFileSync(path.join(h, 'control-proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
    out(`Control proof: signed and verified a message with this key (${proof.valid ? 'VALID' : 'INVALID'}). Saved to control-proof.json.`);
    out(`Limits: allowHosts [] (add hosts with "config allow"), $${cfg.maxPerCallUsd}/call, $${cfg.dailyCapUsd}/24h, $${cfg.lifetimeCapUsd} lifetime.`);
    return out(fundingGuide(cfg, address));
  }
  const cfg = loadConfig(h);
  if (cmd === 'prove') return out(await proveControl(loadAccount(cfg)));
  if (cmd === 'fund') return out(fundingGuide(cfg, readAddress(cfg)));
  if (cmd === 'config') {
    const sub = pos[1];
    if (!sub || sub === 'show') return out({ home: h, ...cfg });
    if (sub === 'allow' || sub === 'disallow') {
      const host = pos[2]; if (!host) throw new Error('give a host, e.g. x402.org');
      cfg.allowHosts = sub === 'allow' ? [...new Set([...cfg.allowHosts, host])] : cfg.allowHosts.filter((x) => x !== host);
      saveConfig(h, cfg); return out({ allowHosts: cfg.allowHosts });
    }
    if (sub === 'set') {
      const [k, v] = [pos[2], pos[3]]; if (!k || v === undefined) throw new Error('usage: config set <key> <json-value>');
      let val; try { val = JSON.parse(v); } catch { val = v; }
      const parts = k.split('.'); let o = cfg; while (parts.length > 1) o = o[parts.shift()] ||= {}; o[parts[0]] = val;
      if (k === 'network' && val === 'base' && cfg.confirmMainnet !== MAINNET_CONFIRM_PHRASE) out(`Note: mainnet stays locked until you also run: config set confirmMainnet "${MAINNET_CONFIRM_PHRASE}"`);
      saveConfig(h, cfg); loadConfig(h); return out({ [k]: val });
    }
    throw new Error(`unknown config command ${sub}`);
  }
  const w = new SafeWallet({ home: h, config: cfg });
  const reqArgs = () => ({ url: pos[1], method: flags.method, body: flags.body, maxUsd: flags['max-usd'] ? Number(flags['max-usd']) : undefined, idempotencyKey: flags.key, kind: flags.topup ? 'topup' : undefined });
  switch (cmd) {
    case 'balances': return out(await w.balances([].concat(flags.token || [])));
    case 'quote': return out(await w.quote(reqArgs()));
    case 'pay': { const r = await w.pay(reqArgs()); out(r); process.exitCode = r.ok ? 0 : 3; return; }
    case 'status': return out(w.status());
    case 'receipts': return out(w.receipts({ limit: Number(flags.limit || 20), status: flags.status }));
    case 'dispute': return out(await w.disputePacket(pos[1]));
    case 'breaker': if (pos[1] !== 'reset' || !pos[2]) throw new Error('usage: breaker reset <host>'); return out(w.breakerReset(pos[2], flags.note || 'reset by human via CLI'));
    case 'sweep': return out(await w.sweep({ confirm: flags.confirm === true }));
    default: throw new Error(`unknown command ${cmd}. Run with --help.`);
  }
}
main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
