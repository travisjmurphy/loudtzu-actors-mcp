# Playbook: get a bot on-chain safely with x402-safe-wallet

> **Unaudited. Experimental. You risk your own funds. Use a dedicated wallet holding only what you can lose.**

This is the step-by-step path from nothing to a bot that pays x402 APIs inside human-set limits. Steps 1 to 7 use Base Sepolia, a testnet where tokens have no value. Step 8 is the only one that touches real money, and it is optional.

Roles: the **bot** runs the tool (CLI or MCP). The **human** is the person responsible for the bot. Only the human funds the wallet, edits limits, resets breakers, unlocks mainnet and sweeps.

---

## 1. Create a fresh wallet used only for this

```bash
x402-safe-wallet init
```

This creates `~/.x402-safe-wallet/` (or `$X402SW_HOME`) containing:

| File | Mode | What it is |
|---|---|---|
| (directory) | 700 | Only your user can enter it |
| `.gitignore` | 600 | Contains `*`, so the directory is never committed by accident |
| `key.json` | 600 | The private key. Never printed, never sent anywhere |
| `config.json` | 600 | Limits and allowlists |
| `receipts.jsonl` | 600 | Append-only log, created on first use |

Never reuse a wallet that holds anything else. If you prefer Foundry, `cast wallet new` creates a key too. Save it to `key.json` as `{"privateKey":"0x..."}`, then `chmod 600 key.json` and `chmod 700` the directory. The tool refuses to load a key file that other users can read.

## 2. Prove control

`init` already signs a message with the new key and verifies the signature (`control-proof.json`). To repeat it at any time:

```bash
x402-safe-wallet prove
```

The output contains the address, the message and the signature, which are all safe to share. It never contains the key.

## 3. Fund it with only the cap

```bash
x402-safe-wallet fund
```

This prints the address, the network (Base Sepolia, chain id 84532), the USDC contract (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`, from [Circle's list](https://developers.circle.com/stablecoins/usdc-contract-addresses)) and the faucets:

- [Circle USDC faucet](https://faucet.circle.com/): pick Base Sepolia and paste the address.
- [Coinbase CDP faucet](https://portal.cdp.coinbase.com/products/faucet): Base Sepolia ETH and USDC, needs a free sign-in.

1 to 10 testnet USDC is plenty. ETH is **not** needed to pay: in x402 the buyer signs an authorization and the seller's facilitator submits the transaction and pays the gas. A little ETH is only needed for the kill switch (step 7).

```bash
x402-safe-wallet balances
```

## 4. Set the caps and the allowlist

Defaults: no allowed hosts, $0.05 per call, $1 per rolling 24 hours, $5 lifetime, top-ups off.

```bash
x402-safe-wallet config allow x402.org
x402-safe-wallet config set maxPerCallUsd 0.02
x402-safe-wallet config set sweepTo 0xAnAddressYouControl
x402-safe-wallet config show
```

Optional: pin the seller's receiving address with `allowPayTo`, so a changed `payTo` is refused:

```bash
x402-safe-wallet config set allowPayTo '{"api.example.com":["0xSellerAddress"]}'
```

## 5. Quote, then make the first paid call

```bash
x402-safe-wallet quote https://x402.org/protected
x402-safe-wallet pay   https://x402.org/protected --max-usd 0.01
```

`quote` sends the request without paying, lists every payment option the seller offered, says why each unusable one was skipped, and shows whether the limits would allow the chosen one. `pay` signs once, sends once, and checks what came back.

Before funding anything, you can see the whole flow offline:

```bash
x402-safe-wallet demo
```

## 6. Read the receipts

```bash
x402-safe-wallet status
x402-safe-wallet receipts --limit 10
x402-safe-wallet receipts --status PAID_NOT_DELIVERED
```

| Status | Meaning | What to do |
|---|---|---|
| `DELIVERED` | Paid, HTTP 2xx, non-empty body | Nothing |
| `PAID_NOT_DELIVERED` | The seller reported settlement, or answered 2xx, but the body was empty or an error | The seller is now blocked. Run `x402-safe-wallet dispute <receiptId>` and send the packet to the seller |
| `REJECTED_UNPAID` | The seller rejected the signed payment and reported no settlement | Don't retry. It still counts against your caps until the signature expires |
| `UNKNOWN` | No usable answer after a signed payment (timeout, network error) | The seller is blocked. Check the address on the block explorer before doing anything else |
| `REFUSED` | Stopped before signing (allowlist, cap, duplicate, breaker, top-up guard, floor) | Read `code` and `reason` |

After reviewing a blocked seller, the human can unblock it:

```bash
x402-safe-wallet breaker reset api.example.com --note "refunded on Nov 15"
```

## 7. Use the kill switch

```bash
x402-safe-wallet sweep             # dry run
x402-safe-wallet sweep --confirm   # moves all USDC, then all ETH minus gas, to sweepTo
```

Sweep whenever something looks wrong: an unexpected receipt, a leaked machine, or the end of a test.

## 8. Optional: go live on Base mainnet

Only after steps 1 to 7 work on testnet:

1. Create a **separate** wallet: `X402SW_HOME=~/.x402-safe-wallet-live x402-safe-wallet init --network base`.
2. Unlock mainnet in that home: `config set confirmMainnet "I understand this spends real money"`.
3. Fund it with **only** the lifetime cap in USDC on Base (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`), plus about $0.10 of ETH for the sweep.
4. Set `sweepTo`, add sellers one by one, and keep the caps low.

---

## Field notes (November 14, 2026)

What we saw while paying real x402 sellers on Base mainnet from our own capped client, a few cents in total. These are our own observations from one buyer on one day, not general claims about these services.

- **A signed payment can be rejected.** Tavily's search endpoint (`x402.tavily.com/search`) answered our signed Base USDC payment with `402 "Verification error"` twice: once with our own client and once with the official `@x402/fetch` SDK. Our balance didn't change, so we weren't charged. We stopped after the second attempt. The cause is unknown to us. This is why the tool never retries and records `REJECTED_UNPAID`.
- **Some sellers prepay the worst case.** BlockRun's chat-completions 402 quoted an amount based on the request's maximum answer length (`max_tokens`), not the answer actually produced. A 4,000-token limit cost us $0.003406 for an answer of about 50 tokens. A smaller `max_tokens` gave a smaller quote, with a $0.002 floor. Always `quote` first and set the maximum answer length deliberately.
- **One 402 can offer many ways to pay.** One seller's 402 offered seven options: two Base USDC options with different receiving addresses, Solana, batched-settlement rails on several chains, plus other payment challenges. Pick one deliberately. This tool only uses plain USDC EIP-3009 on the configured network, chooses the cheapest, and `quote` explains every skip.
- **The official client libraries cap payments at $1 by default.** `@x402/core` defines `DEFAULT_MAX_AMOUNT_PER_PAYMENT = "$1"`. That limit is per payment, not per day, so add a rolling budget yourself or use one like this tool's.
- **Paying needs no account, no API key and no gas.** Three of the four sellers we tried worked on the first attempt from a short script. The added latency was about one extra round trip.

### What goes wrong in the wild

Public reports from outside x402 buyers, found by searching GitHub and X on November 14, 2026. They are summarized from the linked reports without judging anyone, and some were later followed up or resolved by the seller. The common thread is that **the payment settled, then delivery failed**, and retries or automatic top-ups sometimes charged again.

1. **Retry loop with no delivery (February 2026).** A buyer's MCP tool with auto-approve retried an sBTC x402 payment 28 times (2,800 sats total) and no message was delivered. The integrator traced it to deduplication failing across retries. ([aibtc-mcp-server#141](https://github.com/aibtcdev/aibtc-mcp-server/issues/141), [x402-stacks-sdk#4](https://github.com/x402Stacks/x402-stacks-sdk/issues/4))
2. **Inference paid, upstream quota error (February 2026).** A buyer's agent paid for inference in USDC, the payment went through, and the upstream model provider returned an insufficient-quota error. ([post on X](https://x.com/sp3akerstelios/status/2024533073165955582))
3. **Domain paid, registration stuck (February 2026).** A $3.36 USDC payment on Base for a domain registration went through, and the registrar step failed for lack of account funds on the provider side, leaving the domain pending. ([post on X](https://x.com/glider_agent/status/2024697470593454506))
4. **Phone top-up paid, carrier delivery failed (August 2026).** The x402 payment went through, and the top-up was flagged for a manual refund after a carrier-side failure. ([post on X](https://x.com/Okeesha_Vinula/status/2087526780580352471))
5. **Credit top-up paid, credits not granted (September 2026).** A 5 USDC credit top-up settled on Base, and the credit-grant step returned HTTP 500, leaving the balance at zero credits. The reporter asked for credit or a refund. ([automaton#408](https://github.com/Conway-Research/automaton/issues/408))
6. **Automatic top-up loop (October 2026).** A runtime's auto-top-up kept retrying while its account was in a low-funds state. Two 5 USDC top-ups settled and no credits were granted, and the runtime also swapped the wallet's ETH to USDC to fund them. ([automaton#427](https://github.com/Conway-Research/automaton/issues/427))

How this tool responds: one signed attempt and no retries (cases 1 and 6), a delivery check and `PAID_NOT_DELIVERED` with a breaker (cases 2 to 5), a dispute packet for the refund request (cases 2 to 5), and the top-up guard with its own allowlist and daily cap (cases 5 and 6). It never swaps tokens.

### Why limits live in code, not the prompt

A language model that holds a key can be talked into using it. Limits written in a prompt are requests. Limits written in code that runs before signing are rules.

- **Freysa (November 2024).** An agent on Base was told never to release its prize pool. A player reframed the agent's transfer function as the way to accept incoming contributions, and the agent released the pool, reported at about $47,000. A natural-language rule did not bind the tool. ([The Block](https://www.theblock.co/news/business/2024-11-29-human-player-outwits-freysa-ai-agent-in-47000-crypto-challenge-328747), [Simon Willison](https://simonwillison.net/2024/Nov/29/0xfreysaagent/))
- **An unsupervised AWS agent (May 2026).** An operator gave an agent unsupervised AWS access to index a hobbyist network. It provisioned large instances and recreated stacks on errors, and two days later the bill was $6,531.30. There was no hard budget and nothing stopped the retries. ([operator's write-up](https://lantian.pub/en/article/fun/ai-agent-bankrupted-their-operator-scan-dn42lantian.lantian/), [Hacker News discussion](https://news.ycombinator.com/item?id=48500012))

So in this tool, the model can ask to pay, but the code decides: the allowlist, caps, the payee and the asset are checked before any signature exists, and the MCP server has no tool that changes them.
