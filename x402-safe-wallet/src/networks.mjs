// Supported networks. Base Sepolia (testnet) is the default; Base mainnet needs an explicit opt-in.
// USDC addresses are from Circle's published list:
// https://developers.circle.com/stablecoins/usdc-contract-addresses
import { base, baseSepolia } from 'viem/chains';

export const NETWORKS = {
  'base-sepolia': {
    key: 'base-sepolia',
    chain: baseSepolia,
    chainId: 84532,
    caip2: 'eip155:84532',
    v1Name: 'base-sepolia',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    // EIP-712 domain of the testnet USDC contract (read on-chain: name() = "USDC", version() = "2").
    usdcDomainNames: ['USDC'],
    rpcUrl: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    testnet: true,
  },
  base: {
    key: 'base',
    chain: base,
    chainId: 8453,
    caip2: 'eip155:8453',
    v1Name: 'base',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    usdcDomainNames: ['USD Coin', 'USDC'],
    rpcUrl: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    testnet: false,
  },
};

export function getNetwork(key) {
  const n = NETWORKS[key];
  if (!n) throw new Error(`Unknown network "${key}". Use "base-sepolia" (default) or "base".`);
  return n;
}

export const FAUCETS = [
  { name: 'Circle USDC faucet (Base Sepolia USDC)', url: 'https://faucet.circle.com/' },
  { name: 'Coinbase CDP faucet (Base Sepolia ETH and USDC)', url: 'https://portal.cdp.coinbase.com/products/faucet' },
];

// Public x402 demo endpoint run by the x402 project. It asks for 0.01 testnet USDC on Base Sepolia.
export const TESTNET_DEMO_URL = 'https://x402.org/protected';
