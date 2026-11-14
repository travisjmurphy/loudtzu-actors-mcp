// Key handling. The private key is read from a file (mode 600) or X402SW_PRIVATE_KEY, used to sign, and never printed.
import fs from 'node:fs';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { verifyMessage } from 'viem';

export function createWallet(keyFile) {
  if (fs.existsSync(keyFile)) throw new Error(`A key already exists at ${keyFile}. Refusing to overwrite it.`);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  fs.writeFileSync(keyFile, JSON.stringify({ address: account.address, privateKey: pk, createdAt: new Date().toISOString() }) + '\n', { mode: 0o600, flag: 'wx' });
  fs.chmodSync(keyFile, 0o600);
  return account.address;
}

export function loadAccount(cfg) {
  let pk = process.env.X402SW_PRIVATE_KEY;
  if (!pk) {
    if (!fs.existsSync(cfg.keyFile)) throw new Error(`No wallet yet. Run "x402-safe-wallet init" first (looked for ${cfg.keyFile}).`);
    const mode = fs.statSync(cfg.keyFile).mode & 0o077;
    if (mode) throw new Error(`Key file ${cfg.keyFile} is readable by other users. Run: chmod 600 "${cfg.keyFile}"`);
    let raw;
    try { raw = JSON.parse(fs.readFileSync(cfg.keyFile, 'utf8')); } catch { throw new Error('Key file is not valid JSON.'); }
    pk = raw.privateKey;
  }
  if (typeof pk !== 'string' || !/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) throw new Error('Private key is missing or malformed (value not shown).');
  return privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
}

export function readAddress(cfg) {
  if (process.env.X402SW_PRIVATE_KEY) return loadAccount(cfg).address;
  if (!fs.existsSync(cfg.keyFile)) return null;
  return JSON.parse(fs.readFileSync(cfg.keyFile, 'utf8')).address;
}

// Proves the key in the keystore controls the address: sign a message and verify it.
export async function proveControl(account) {
  const message = `x402-safe-wallet control proof for ${account.address} at ${new Date().toISOString()}`;
  const signature = await account.signMessage({ message });
  const valid = await verifyMessage({ address: account.address, message, signature });
  return { address: account.address, message, signature, valid };
}
