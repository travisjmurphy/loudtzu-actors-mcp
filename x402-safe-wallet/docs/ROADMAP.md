# Roadmap

Nothing here exists yet. Items ship only after separate review and approval.

## Trading module (future, off by default)

A possible later module that lets a bot place small token swaps on Base from the same dedicated wallet. It is **not built**. If it is ever built, it would:

- be **off by default** and need its own explicit opt-in, separate from x402 payments
- have its own caps: a maximum trade size, a slippage stop, a token allowlist, and a daily loss limit
- keep an append-only trade log in the same receipt format, with the same kill switch
- ship only after its own code review and approval

It would provide no investment advice, no signals and no profit claims, and it would never hold or manage anyone else's funds.

## Other ideas under consideration

- Check settlement transactions on-chain automatically and attach the result to each receipt.
- Support the x402 offer-and-receipt extension when sellers issue signed receipts.
- Expire `REJECTED_UNPAID` reservations once the signed authorization's `validBefore` has passed and the nonce is confirmed unused on-chain.
