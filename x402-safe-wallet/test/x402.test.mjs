// Offline checks for PaymentPayload extension echo. No funds, no chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { signPayment } from '../src/x402.mjs';
import { NETWORKS } from '../src/networks.mjs';

const net = NETWORKS['base-sepolia'];

function requirement() {
  return {
    scheme: 'exact',
    network: net.caip2,
    amount: '10000',
    asset: net.usdc,
    payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
    maxTimeoutSeconds: 60,
    extra: { name: 'USDC', version: '2' },
  };
}

const bazaarExtensions = {
  bazaar: {
    info: {
      input: { type: 'http', method: 'GET', queryParams: { chain: 'base', token: '0xabc' } },
      output: { type: 'json', example: { verdict: 'OK' } },
    },
    schema: { type: 'object', required: ['input'] },
  },
};

test('v2 payload extensions, including bazaar, deep-equal the 402', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const req = requirement();
  const pr = {
    x402Version: 2,
    resource: { url: 'https://example.com/check' },
    accepts: [req],
    extensions: bazaarExtensions,
  };
  const { payload } = await signPayment(account, pr, req, net, 1_700_000_000);
  assert.deepEqual(payload.extensions, pr.extensions);
  assert.deepEqual(payload.extensions.bazaar, bazaarExtensions.bazaar);
  assert.notEqual(payload.extensions, pr.extensions);
});

test('v2 402 with no extensions produces a payload with no extensions field', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const req = requirement();
  const pr = { x402Version: 2, resource: { url: 'https://example.com/check' }, accepts: [req] };
  const { payload } = await signPayment(account, pr, req, net, 1_700_000_000);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'extensions'), false);
  assert.equal(payload.extensions, undefined);
});

test('v2 402 with empty extensions object is echoed as empty, not dropped or invented further', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const req = requirement();
  const pr = { x402Version: 2, resource: { url: 'https://example.com/check' }, accepts: [req], extensions: {} };
  const { payload } = await signPayment(account, pr, req, net, 1_700_000_000);
  assert.deepEqual(payload.extensions, {});
});
