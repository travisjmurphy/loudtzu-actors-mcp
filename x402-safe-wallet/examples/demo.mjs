// Offline demo: a throwaway wallet pays the bundled mock seller and shows each guard working.
// No funds, no chain, nothing leaves this machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { SafeWallet } from '../src/wallet.mjs';
import { DEFAULTS } from '../src/config.mjs';
import { startMockSeller } from './mock-seller.mjs';

export async function runDemo() {
  const seller = await startMockSeller({ port: 0 });
  const host = `127.0.0.1:${seller.port}`; const base = `http://${host}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'x402sw-demo-'));
  const w = new SafeWallet({ home, account: privateKeyToAccount(generatePrivateKey()), getUsdcBalance: async () => 5,
    config: { ...DEFAULTS, keyFile: path.join(home, 'unused'), allowHosts: [host], dailyCapUsd: 0.1 } });
  const show = (label, r) => console.log(`${label.padEnd(52)} -> ${r.status}${r.code ? ` ${r.code}` : ''}${r.amountUsd ? ` $${r.amountUsd}` : ''}${r.reason ? `\n${' '.repeat(56)}${r.reason}` : ''}`);
  console.log(`Offline demo. Mock seller at ${base} (simulated settlement). Temporary home ${home}\n`);
  const q = await w.quote({ url: `${base}/multi` });
  console.log(`quote /multi: ${q.options.length} options offered, ${q.options.filter((o) => o.usable).length} usable, chose $${q.chosen.amountUsd}`);
  show('pay /paid', await w.pay({ url: `${base}/paid` }));
  show('pay /paid again (same request, no new key)', await w.pay({ url: `${base}/paid` }));
  show('pay /paid with a new idempotency key', await w.pay({ url: `${base}/paid`, idempotencyKey: 'demo-2' }));
  show('pay /expensive ($0.50 > $0.05 cap)', await w.pay({ url: `${base}/expensive` }));
  show('pay /credits/topup (top-up not allowlisted)', await w.pay({ url: `${base}/credits/topup` }));
  show('pay https://example.com/ (host not allowlisted)', await w.pay({ url: 'https://example.com/' }));
  show('pay /reject (seller rejects signed payment)', await w.pay({ url: `${base}/reject` }));
  const bad = await w.pay({ url: `${base}/error` });
  show('pay /error (settles, then HTTP 500)', bad);
  show('pay /paid?next (seller now blocked by breaker)', await w.pay({ url: `${base}/paid?next` }));
  const d = await w.disputePacket(bad.receiptId, { checkChain: false });
  console.log(`\ndispute packet written: ${d.file}`);
  console.log(`status: ${JSON.stringify(w.status().spent)}`);
  console.log(`seller saw ${seller.calls.requests} HTTP requests and settled ${seller.calls.settled} payments; no request was retried.`);
  await seller.close();
}
