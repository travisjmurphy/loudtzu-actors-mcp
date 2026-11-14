// Config and home-directory handling. Everything lives in one private directory (mode 700).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getNetwork } from './networks.mjs';

export const MAINNET_CONFIRM_PHRASE = 'I understand this spends real money';

export const DEFAULTS = Object.freeze({
  network: 'base-sepolia',          // testnet by default
  confirmMainnet: false,            // must be set to MAINNET_CONFIRM_PHRASE to use network "base"
  keyFile: null,                    // defaults to <home>/key.json
  rpcUrl: null,                     // defaults to the network's public RPC
  allowHosts: [],                   // EMPTY: nothing can be paid until the human adds hosts
  allowPayTo: {},                   // optional: { "host": ["0xSeller..."] } to pin seller addresses
  maxPerCallUsd: 0.05,
  dailyCapUsd: 1,                   // rolling 24 hours
  lifetimeCapUsd: 5,
  usdcFloorUsd: 0,                  // refuse a payment that would leave less than this in the wallet
  idempotencyWindowHours: 24,
  breakerThreshold: 1,              // paid-not-delivered results before a seller is blocked
  maxResponseBytes: 5_000_000,
  requestTimeoutMs: 30_000,
  topups: { allowHosts: [], maxPerCallUsd: 0, dailyCapUsd: 0 },
  sweepTo: null,                    // kill switch destination, set by the human
});

export function homeDir(opts = {}) {
  return path.resolve(opts.home || process.env.X402SW_HOME || path.join(os.homedir(), '.x402-safe-wallet'));
}

export function ensureHome(home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const gi = path.join(home, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# Never commit anything in this directory: it holds a private key and payment records.\n*\n', { mode: 0o600 });
  for (const sub of ['responses', 'disputes']) fs.mkdirSync(path.join(home, sub), { recursive: true, mode: 0o700 });
  return home;
}

export function configPath(home) { return path.join(home, 'config.json'); }

export function loadConfig(home) {
  const p = configPath(home);
  const user = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  const cfg = { ...DEFAULTS, ...user, topups: { ...DEFAULTS.topups, ...(user.topups || {}) } };
  if (!cfg.keyFile) cfg.keyFile = path.join(home, 'key.json');
  validateConfig(cfg);
  return cfg;
}

export function saveConfig(home, cfg) {
  const out = { ...cfg };
  if (out.keyFile === path.join(home, 'key.json')) delete out.keyFile;
  fs.writeFileSync(configPath(home), JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
}

export function validateConfig(cfg) {
  getNetwork(cfg.network);
  for (const k of ['maxPerCallUsd', 'dailyCapUsd', 'lifetimeCapUsd', 'usdcFloorUsd']) {
    if (typeof cfg[k] !== 'number' || !(cfg[k] >= 0)) throw new Error(`config.${k} must be a number >= 0`);
  }
  if (!Array.isArray(cfg.allowHosts)) throw new Error('config.allowHosts must be an array of host names');
}

// Mainnet is only allowed when the human set network "base" AND the exact confirm phrase.
export function assertNetworkAllowed(cfg) {
  const net = getNetwork(cfg.network);
  if (!net.testnet && cfg.confirmMainnet !== MAINNET_CONFIRM_PHRASE) {
    const e = new Error(`REFUSED: network "base" spends real USDC. A human must set "confirmMainnet": "${MAINNET_CONFIRM_PHRASE}" in config.json.`);
    e.code = 'MAINNET_NOT_CONFIRMED';
    throw e;
  }
  return net;
}
