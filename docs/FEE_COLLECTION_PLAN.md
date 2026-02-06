# X402 Fee Collection Implementation Plan

## Overview

Add atomic fee collection to the Silverback facilitator using a smart contract that splits payments between endpoint providers and the facilitator treasury.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Current Flow                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Client ──► Permit2 ──► Endpoint Wallet                            │
│              (full amount)                                           │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                          New Flow                                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Client ──► Permit2 ──► FeeSplitter ──┬──► Endpoint (amount - fee) │
│              (full amount)             │                             │
│                                        └──► Treasury (fee)          │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Fee Structure

| Token | Fee | Rationale |
|-------|-----|-----------|
| BACK | 0% (exempt) | Drive $BACK adoption |
| USDC | 0.1% | Stablecoin base rate |
| USDT | 0.1% | Stablecoin base rate |
| DAI | 0.1% | Stablecoin base rate |
| USDbC | 0.1% | Stablecoin base rate |
| VIRTUAL | 0.1% | Ecosystem token |
| WETH | 0.25% | Blue-chip premium |
| cbBTC | 0.25% | Blue-chip premium |

## Components

### 1. Smart Contract: X402FeeSplitter.sol

**Location**: `contracts/X402FeeSplitter.sol`

**Functions**:
- `splitPayment(token, payer, recipient, amount)` - Split incoming payment
- `setTokenFee(token, feeBps)` - Configure per-token fees
- `setTreasury(address)` - Update treasury address
- `emergencyWithdraw(token, amount)` - Recovery function

**Security**:
- ReentrancyGuard on splitPayment
- Ownable for admin functions
- SafeERC20 for transfers
- Max fee cap (10%)

### 2. Facilitator Settlement Update

**File**: `src/services/settlement.ts`

**Changes**:
- After Permit2 transfer to FeeSplitter, call `splitPayment()`
- Track fees in database
- Emit events for analytics

### 3. x402 Server Update (Silverback main repo)

**File**: `apps/agent/src/x402/server.ts`

**Changes**:
- Set `payTo = FeeSplitter` in 402 responses
- Store actual endpoint wallet in `extra.actualRecipient`
- Facilitator reads `actualRecipient` during settlement

## Implementation Phases

### Phase 1: Contract Development (No Production Impact)
- [x] Write X402FeeSplitter.sol
- [ ] Write comprehensive tests
- [ ] Deploy to Base Sepolia testnet
- [ ] Verify on Basescan

### Phase 2: Facilitator Integration (Testnet Only)
- [ ] Add FeeSplitter service to facilitator
- [ ] Update settlement to call splitPayment
- [ ] Test with testnet tokens

### Phase 3: x402 Server Update (Testnet)
- [ ] Add FEE_SPLITTER_ADDRESS config
- [ ] Modify payTo for paid endpoints
- [ ] Test full flow on testnet

### Phase 4: Production Deployment
- [ ] Deploy FeeSplitter to Base Mainnet
- [ ] Configure token fees
- [ ] Enable feature flag
- [ ] Monitor first settlements

## Testing Strategy

### Unit Tests
```typescript
// contracts/test/X402FeeSplitter.test.ts
- Test fee calculation (0%, 0.1%, 0.25%)
- Test splitPayment with various amounts
- Test admin functions
- Test edge cases (0 amount, max amount)
- Test reentrancy protection
```

### Integration Tests
```typescript
// src/__tests__/fee-splitter-integration.test.ts
- Test full settlement flow with splitter
- Test multi-token support
- Test fee tracking in database
```

### E2E Tests
```bash
# scripts/test-fee-splitter-e2e.ts
- Deploy to testnet
- Make test payment
- Verify split
- Check balances
```

## Configuration

### Environment Variables

```bash
# Facilitator
X402_FEE_SPLITTER_ADDRESS=0x...  # FeeSplitter contract
X402_FEE_SPLITTER_ENABLED=true   # Feature flag
FACILITATOR_FEE_RECIPIENT=0x...  # Treasury address

# x402 Server
X402_USE_FEE_SPLITTER=true       # Use splitter as payTo
```

## Rollback Plan

1. Set `X402_FEE_SPLITTER_ENABLED=false` on facilitator
2. Set `X402_USE_FEE_SPLITTER=false` on x402 server
3. System reverts to direct endpoint payments
4. No funds at risk (splitter only receives new payments)

## Gas Costs

| Operation | Estimated Gas | Cost @ 0.01 gwei |
|-----------|---------------|------------------|
| splitPayment (2 transfers) | ~65,000 | ~$0.0013 |
| Permit2 transfer | ~55,000 | ~$0.0011 |
| **Total overhead** | ~10,000 | ~$0.0002 |

Fee collection is economically viable for payments > $0.02.

## Timeline

1. **Day 1**: Contract tests, testnet deployment
2. **Day 2**: Facilitator integration, testnet testing
3. **Day 3**: x402 server update, full flow testing
4. **Day 4**: Production deployment, monitoring

## Monitoring

- Track `Settlement` events from contract
- Dashboard for collected fees per token
- Alert on settlement failures
- Weekly fee report
