# x402-safe-wallet

> **Unaudited. Experimental. You risk your own funds. Use a dedicated wallet holding only what you can lose.**

A full-service wallet tool for bots that need to get on-chain safely: create a dedicated wallet, prove it works on a testnet, build against a local x402 seller, and only then spend real USDC on [x402](https://x402.org/) APIs, inside limits a human sets.

It is one tool with four stages, available as a CLI and as an MCP server (stdio):

1. **Onboard.** Create a fresh wallet, store the key safely, prove control, get funded.
2. **Test.** Pay a public x402 demo on **Base Sepolia** (the default network) with free testnet USDC.
3. **Build.** Develop against the bundled mock seller, offline or with real testnet settlement.
4. **Spend.** Switch to Base mainnet only by an explicit human opt-in, with receipts, idempotency, fail-closed delivery checks, a seller circuit breaker, dispute packets, a top-up guard, caps and a kill switch.

A bot can reach a working, paying setup without touching real money. Base mainnet stays locked until a human unlocks it.

Requires Node.js 20 or newer. Dependencies: `viem`, `@modelcontextprotocol/sdk`, `zod`.

## What this adds, and what already exists

Spending caps for x402 buyers are not new, and this tool does not claim to be first. Use these if they fit you better:

- The official x402 client libraries (TypeScript, Python, Go) ship **spend controls with a $1 default per-payment cap** ([buyer quickstart, "Spend Controls"](https://docs.x402.org/getting-started/quickstart-for-buyers), [SDK feature table](https://docs.x402.org/sdk-features)).
- Coinbase CDP offers client-side spend limits on `CdpX402Client`, on-chain [Spend Permissions and off-chain Policies](https://docs.cdp.coinbase.com/wallets/using-wallets/spend-permissions) ([x402 FAQ](https://docs.cdp.coinbase.com/x402/support/faq)).
- AWS Bedrock AgentCore Payments supports per-session spending limits ([concepts](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-concepts.html)).
- Open-source limiters: [x402-agent-wallet](https://github.com/nirholas/x402-agent-wallet), [x402-seatbelt](https://github.com/gmahar82-stack/x402-seatbelt), [Boundra](https://github.com/gobeyondfj-cmd/boundra), [Sentinel](https://github.com/nivang/Sentinel).

Public reports from x402 buyers mostly describe a different problem than a missing cap: **the payment settled, then the service failed or delivered nothing**, sometimes followed by retries or automatic top-ups that charged again (see [docs/PLAYBOOK.md](docs/PLAYBOOK.md#what-goes-wrong-in-the-wild)). So the caps here are baseline safety, and the focus is on what happens around each payment:

| Feature | What it does |
|---|---|
| **Receipts** | Append-only JSONL log of every quote, refusal, payment, sweep and breaker reset, with the HTTP status, response size and SHA-256, and the settlement reported by the seller. |
| **Idempotency** | The same request (method + URL + body) is never paid twice within 24 hours unless the caller passes a new `idempotencyKey`, and a key is never paid twice. |
| **Fail-closed** | One signed attempt per payment. No automatic retries, ever. Timeouts and unclear answers are recorded as `UNKNOWN` and counted against the caps. |
| **Delivery check** | A 2xx with an empty or error-only body, or an error after settlement, is recorded as `PAID_NOT_DELIVERED`. |
| **Seller circuit breaker** | One `PAID_NOT_DELIVERED` or `UNKNOWN` blocks that seller until a human reviews it and resets the breaker. |
| **Dispute packet** | Bundles the receipt, settlement tx (checked on-chain when possible), request, response excerpt, hashes and timestamps into one JSON file you can send to the seller to ask for a refund. |
| **Top-up guard** | Prepaid credit top-ups are refused unless the host is on a separate top-up allowlist, with its own per-call and daily caps. |
| **Option choice** | When a 402 offers several ways to pay, only plain USDC EIP-3009 `exact` on the configured network is used, and the cheapest valid option wins. `x402_quote` shows why every other option was skipped. |

## Quickstart

```bash
npm install -g x402-safe-wallet      # or run from a checkout: node bin/cli.mjs <command>

# 1. Onboard (Base Sepolia testnet by default)
x402-safe-wallet init                # fresh wallet, key mode 600 in a mode-700 dir, control proof, funding step
x402-safe-wallet fund                # shows the address, the amount and the faucets again
x402-safe-wallet balances            # ETH and USDC; add --token 0x... for any other ERC-20

# 2. Test: no funds needed for the offline demo
x402-safe-wallet demo                # throwaway wallet vs the bundled mock seller; shows every guard firing

# ...then a real testnet payment (after getting free testnet USDC from a faucet)
x402-safe-wallet config allow x402.org
x402-safe-wallet quote https://x402.org/protected              # dry run, never signs
x402-safe-wallet pay   https://x402.org/protected --max-usd 0.01
x402-safe-wallet receipts --limit 5

# 3. Build against a local seller
node examples/mock-seller.mjs --port 4021                                   # simulated settlement, no chain
node examples/mock-seller.mjs --port 4021 --facilitator https://x402.org/facilitator --pay-to 0xYourOtherAddress   # real Base Sepolia settlement
x402-safe-wallet config allow 127.0.0.1:4021
x402-safe-wallet pay http://127.0.0.1:4021/paid

# 4. Spend (real money): see "Going live" below
```

**Real Base Sepolia example** (November 14, 2026, 3:19 PM AST; testnet USDC from the Circle faucet, no real value):

```bash
x402-safe-wallet config allow x402.org
x402-safe-wallet pay https://x402.org/protected --max-usd 0.01
```

```json
{
  "ok": true,
  "paid": true,
  "status": "DELIVERED",
  "reason": null,
  "receiptId": "r_mwgsijw2_96840c0b",
  "amountUsd": 0.01,
  "settlementTx": "0xc1dd3c242ab364c3a6b766c442fdda23da5a3b189b3b79728371d75f44d013a7",
  "httpStatus": 200,
  "bytes": 7978,
  "body": "<7,978 bytes of HTML, omitted here>",
  "next": null
}
```

The settlement on the explorer: [0xc1dd3c24…d013a7](https://sepolia.basescan.org/tx/0xc1dd3c242ab364c3a6b766c442fdda23da5a3b189b3b79728371d75f44d013a7), a 0.01 USDC transfer from the test wallet `0x9615472E4906fcc8FC3f76C8A596265Fd3E1cf98` to the demo seller, submitted (and its gas paid) by the x402.org facilitator. The receipt log entry also records the response's SHA-256 and content type.

Testnet faucets: [Circle USDC faucet](https://faucet.circle.com/) (Base Sepolia USDC) and the [Coinbase CDP faucet](https://portal.cdp.coinbase.com/products/faucet) (Base Sepolia ETH and USDC, sign-in required). Testnet tokens have no value. x402 payments are gasless for the buyer, so ETH is only needed for the kill switch.

### MCP server

```json
{
  "mcpServers": {
    "x402-safe-wallet": {
      "command": "npx",
      "args": ["-y", "x402-safe-wallet", "mcp"],
      "env": { "X402SW_HOME": "/home/you/.x402-safe-wallet" }
    }
  }
}
```

Tools: `wallet_init`, `balances`, `x402_quote`, `x402_pay`, `spend_status`, `receipts`, `dispute_packet`.

The MCP server deliberately **cannot** change limits or allowlists, switch networks, reset a circuit breaker, or sweep funds. Those are CLI commands for the human.

## Stages in detail

### 1. Onboard

`init` creates `~/.x402-safe-wallet/` (or `$X402SW_HOME`) with mode 700, a `.gitignore` containing `*`, a fresh key in `key.json` with mode 600, and a default `config.json`. It never overwrites an existing key. It then signs a message with the new key and verifies it (`control-proof.json`), and prints the funding step for the human: address, network, token contract, how much to send and where to get it. The key is never printed. It is loaded from the key file (refused if other users can read it) or from `X402SW_PRIVATE_KEY`.

### 2. Test (Base Sepolia, chain id 84532)

- USDC: `0x036CbD53842c5426634e7929541eC2318f3dCF7e` ([Circle's address list](https://developers.circle.com/stablecoins/usdc-contract-addresses)).
- Public demo seller: `https://x402.org/protected` asks for 0.01 testnet USDC.
- `quote` lists every payment option offered and which one would be used, without signing.

### 3. Build

`examples/mock-seller.mjs` is a small x402 v2 seller with routes that misbehave on purpose: `/paid`, `/empty`, `/error`, `/reject`, `/expensive`, `/credits/topup` and `/multi`. By default it verifies the EIP-3009 signature locally and simulates settlement. With `--facilitator https://x402.org/facilitator` it asks the public testnet facilitator to verify and settle for real on Base Sepolia. `npm test` runs the whole test suite against it offline.

### 4. Spend: going live on Base mainnet

Mainnet needs two explicit settings in `config.json`, made by a human:

```bash
x402-safe-wallet config set network base
x402-safe-wallet config set confirmMainnet "I understand this spends real money"
```

Use a **separate, fresh wallet** for mainnet (for example `X402SW_HOME=~/.x402-safe-wallet-live x402-safe-wallet init --network base`), fund it with only your lifetime cap, set `sweepTo` to an address you control, and add sellers one by one.

## Safety model

Every limit is enforced in code, before anything is signed. A prompt cannot raise them, but anything that can write files can (see below).

**Caps guard against mistakes, not attackers.** The config caps, the allowlist and the mainnet confirm phrase protect against mistakes: a typo, a looping bot, a seller that overcharges. They are not a security boundary. Any bot or process with shell or file access to this machine can edit `config.json` and raise them. The MCP server's lock (it can't change limits, the network or the sweep address) only helps when the bot has no shell access. The real limit is how much is in the wallet. So the human should set the caps themselves, and fund the wallet with no more than the lifetime cap.

| Setting (`config.json`) | Default | Notes |
|---|---|---|
| `network` | `base-sepolia` | `base` also needs `confirmMainnet` set to the exact phrase |
| `allowHosts` | `[]` | Nothing can be paid until a human adds a host |
| `allowPayTo` | `{}` | Optional: pin seller addresses per host |
| `maxPerCallUsd` | `0.05` | A call's `maxUsd` can only lower it |
| `dailyCapUsd` | `1` | Rolling 24 hours |
| `lifetimeCapUsd` | `5` | Per network |
| `usdcFloorUsd` | `0` | Refuse a payment that would leave less than this |
| `idempotencyWindowHours` | `24` | |
| `breakerThreshold` | `1` | Paid-not-delivered results before a seller is blocked |
| `topups` | `{ allowHosts: [], maxPerCallUsd: 0, dailyCapUsd: 0 }` | Top-ups are off by default |
| `sweepTo` | `null` | Destination for the kill switch |

Also fixed in code: USDC on Base or Base Sepolia only; the x402 `exact` scheme with EIP-3009 `transferWithAuthorization` only (no token approvals, no Permit2, no permits, no `upto`); the exact quoted amount to the exact quoted `payTo`; a signature validity of five minutes at most; redirects are not followed; an unreadable balance refuses the payment.

What it does **not** protect against: a compromised machine or leaked key, a seller that delivers bad data with a 200, bugs in this code, or anything you do with the key outside this tool. Signed authorizations that a seller rejected can, in principle, still be settled until they expire, so they count against your caps.

### Kill switch

```bash
x402-safe-wallet config set sweepTo 0xYourSafeAddress
x402-safe-wallet sweep             # dry run: shows what would move
x402-safe-wallet sweep --confirm   # moves all USDC, then all ETH minus gas, to sweepTo
```

The USDC transfer needs a little ETH for gas.

## Docs

- [docs/PLAYBOOK.md](docs/PLAYBOOK.md): step-by-step setup, field notes, and why limits live in code.
- [docs/ROADMAP.md](docs/ROADMAP.md): what may come later.

## License

MIT. No warranty. This software does not give investment advice, does not hold or manage anyone else's funds, and makes no claims about earnings.
