# Silverback x402 Facilitator

Zero-fee x402 payment facilitator supporting USDC settlement on Base (EVM) and Solana (SVM).

**Live:** https://facilitator.silverbackdefi.app

## Overview

Silverback Facilitator is built on the official `@x402/core` + `@x402/evm` + `@x402/svm` SDK. It provides free payment settlement for any x402 resource server — no API keys or setup required.

## Supported Networks

| Network | Asset | Protocol | Address |
|---------|-------|----------|---------|
| Base | USDC | ERC-3009 | `0x48380bcf1c09773c9e96901f89a7a6b75e2bbecc` |
| Solana | USDC | SPL Transfer | `CiFihYLDLZYE92R5FtyHt1YaWiVpv6FJUg1wBjQGEAMQ` |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/supported` | Returns supported kinds, extensions, and signers |
| `POST` | `/verify` | Verify a payment signature |
| `POST` | `/settle` | Execute on-chain settlement |
| `GET` | `/discovery/resources` | Bazaar-compatible resource catalog |
| `GET` | `/health` | Operational status |

## Usage

Use Silverback as your facilitator in any x402 resource server:

```typescript
import { paymentMiddleware } from "x402/express";

app.use(
  paymentMiddleware(
    receiverAddress,
    resourceConfig,
    { url: "https://facilitator.silverbackdefi.app" }
  )
);
```

Or with the `facilitators` package:

```typescript
import { silverback } from "facilitators";
import { paymentMiddleware } from "x402/express";

app.use(paymentMiddleware(receiverAddress, resourceConfig, silverback));
```

## Features

- **Zero fee** — No settlement fee on any transaction
- **ERC-3009** — TransferWithAuthorization for Base USDC
- **SPL Transfer** — Native Solana USDC settlement
- **EIP-6492** — Smart wallet deployment support
- **Bazaar Discovery** — Resources cataloged on successful settlement
- **v1 + v2** — Supports both x402 payload formats

## Tech Stack

- `@x402/core` — Facilitator framework
- `@x402/evm` — EVM scheme (ExactEvmScheme)
- `@x402/svm` — Solana scheme (ExactSvmScheme)
- `@x402/extensions` — Bazaar discovery catalog
- Express.js + esbuild

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FACILITATOR_PRIVATE_KEY` | Yes | EVM signing key (Base) |
| `SOLANA_FACILITATOR_PRIVATE_KEY` | No | SVM signing key (Solana) |
| `BASE_RPC_URL` | No | Custom Base RPC (default: public) |
| `PORT` | No | Server port (default: 3402) |

## Links

- **Website:** https://silverbackdefi.app
- **x402scan:** [Silverback Facilitator](https://x402scan.com/facilitators/silverback)

## License

MIT
