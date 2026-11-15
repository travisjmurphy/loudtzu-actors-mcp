// Offline checks for the Base Sepolia `try` command. No funds, no chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createWallet } from '../src/keystore.mjs';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.mjs');

function run(args, home) {
  return spawnSync(process.execPath, [cli, ...args, '--home', home], { encoding: 'utf8', env: { ...process.env, X402SW_HOME: home } });
}

test('try is listed in --help', () => {
  const r = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\btry\b/);
  assert.match(r.stdout, /Base Sepolia/);
});

test('try refuses a mainnet home and does not create a key', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'x402sw-try-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    network: 'base',
    confirmMainnet: 'I understand this spends real money',
    allowHosts: [],
  }) + '\n');
  const r = run(['try'], home);
  assert.notEqual(r.status, 0);
  assert.match((r.stderr || '') + (r.stdout || ''), /testnet only|will not run against mainnet/i);
  assert.equal(fs.existsSync(path.join(home, 'key.json')), false);
});

function startZeroBalanceRpc() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let id = 1, method = '';
      try { const j = JSON.parse(body || '{}'); id = j.id ?? 1; method = j.method || ''; } catch {}
      const result = method === 'eth_chainId' ? '0x14a34' : method === 'eth_blockNumber' ? '0x1' : ('0x' + '0'.repeat(64));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('try does not persist x402.org into the saved allowlist', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'x402sw-try-'));
  const rpc = await startZeroBalanceRpc();
  const cfgPath = path.join(home, 'config.json');
  const config = {
    network: 'base-sepolia',
    rpcUrl: `http://127.0.0.1:${rpc.address().port}`,
    allowHosts: [],
    maxPerCallUsd: 0.05,
    dailyCapUsd: 1,
    lifetimeCapUsd: 5,
  };
  const raw = JSON.stringify(config, null, 2) + '\n';
  fs.writeFileSync(cfgPath, raw, { mode: 0o600 });
  createWallet(path.join(home, 'key.json'));
  const before = fs.readFileSync(cfgPath);
  // spawnSync would block this process and prevent the in-process RPC stub from answering.
  const r = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [cli, 'try', '--home', home], { env: { ...process.env, X402SW_HOME: home } });
    let stdout = '', stderr = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('try timed out')); }, 15000);
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
  });
  const after = fs.readFileSync(cfgPath);
  rpc.close();
  assert.equal(Buffer.compare(before, after), 0, 'config.json must be byte-identical after try');
  assert.deepEqual(JSON.parse(after.toString()).allowHosts, []);
  assert.doesNotMatch(after.toString(), /x402\.org/);
  assert.match((r.stdout || '') + (r.stderr || ''), /No testnet USDC yet|faucet\.circle\.com/i);
});
