# X402 Fee Splitter Integration Checklist

## Overview

This document outlines all integration points and verification steps needed before production deployment.

---

## 1. Smart Contract Audits

### Security Checks ✅
- [x] Reentrancy protection (ReentrancyGuard)
- [x] Access control (onlyFacilitator, onlyOwner)
- [x] Input validation (zero address, zero amount, insufficient balance)
- [x] Pausable for emergencies
- [x] Two-step ownership transfer (Ownable2Step)
- [x] SafeERC20 for token transfers
- [x] Max fee cap (10%)
- [x] Max settlement limit (optional safety cap)

### Additional Checks Needed
- [ ] What happens if `splitPayment` reverts after Permit2 succeeds?
- [ ] What if endpoint address is a contract that rejects transfers?
- [ ] Gas cost analysis for the extra hop
- [ ] Token with fee-on-transfer compatibility

---

## 2. Facilitator Integration

### Current Settlement Flow
```typescript
// settlement.ts (current)
1. Verify Permit2 signature
2. Execute Permit2 transfer (tokens → receiver)
3. Return success
```

### New Settlement Flow
```typescript
// settlement.ts (with fee splitter)
1. Verify Permit2 signature
2. Execute Permit2 transfer (tokens → FEE_SPLITTER)
3. Call feeSplitter.splitPayment(token, payer, actualRecipient, amount)
4. Return success
```

### Required Changes
- [ ] Add FEE_SPLITTER_ADDRESS env var
- [ ] Add FEE_SPLITTER_ENABLED feature flag
- [ ] Update settle route to call splitPayment after Permit2
- [ ] Pass actualRecipient from payment requirements
- [ ] Handle splitPayment failures gracefully
- [ ] Log fee collection events

### Error Handling
| Scenario | Current Behavior | Required Behavior |
|----------|-----------------|-------------------|
| Permit2 fails | Return error | Return error (no change) |
| splitPayment fails | N/A | Return error, funds in splitter, trigger alert |
| Insufficient gas | N/A | Ensure gas estimate includes splitPayment |

---

## 3. x402 Server (Endpoint Provider)

### Current 402 Response
```json
{
  "payTo": "0x...EndpointWallet",
  "amount": "1000000",
  "asset": "0x...USDC"
}
```

### New 402 Response
```json
{
  "payTo": "0x...FeeSplitter",
  "amount": "1000000",
  "asset": "0x...USDC",
  "extra": {
    "actualRecipient": "0x...EndpointWallet",
    "version": "2"
  }
}
```

### Required Changes
- [ ] Add FEE_SPLITTER_ADDRESS config
- [ ] Add ACTUAL_RECIPIENT config (endpoint's wallet)
- [ ] Update 402 response to use splitter as payTo
- [ ] Include actualRecipient in extra field
- [ ] Feature flag to enable/disable

---

## 4. Data Flow Verification

### Question: Does requester get data?

The x402 middleware flow:
1. Request comes in
2. Check for payment header
3. If no payment → return 402
4. If payment → verify with facilitator
5. If valid → execute endpoint, return data
6. If invalid → return 402

**The fee splitter doesn't change this flow** - it only changes WHERE the payment goes during settlement. The endpoint still delivers data after the facilitator confirms payment.

### Test Cases
- [ ] Client pays → gets data (happy path)
- [ ] Client pays wrong amount → gets 402
- [ ] Client pays to wrong address → gets 402
- [ ] splitPayment fails after Permit2 → ???

---

## 5. Payment Recipient Verification

### Who Gets What?

| Recipient | Amount | Verification |
|-----------|--------|--------------|
| Fee Splitter | Full amount (temporary) | Permit2 transfer |
| Endpoint Wallet | amount - fee | splitPayment transfer |
| Treasury | fee | splitPayment transfer |

### On-Chain Verification
After each settlement, verify:
- [ ] Fee splitter balance = 0 (all funds distributed)
- [ ] Endpoint received (amount × (1 - feeRate))
- [ ] Treasury received (amount × feeRate)
- [ ] Events emitted correctly

---

## 6. Failure Scenarios

### Scenario A: Permit2 Succeeds, splitPayment Fails

**Risk:** Funds stuck in fee splitter contract

**Mitigation:**
1. `emergencyWithdraw()` function exists
2. Owner can recover funds
3. Alert on stuck funds

**Recovery:**
```typescript
// Manual recovery
await feeSplitter.emergencyWithdraw(tokenAddress, amount);
// Funds go to treasury, manually send to endpoint
```

### Scenario B: Fee Splitter is Paused

**Risk:** Settlements fail during pause

**Mitigation:**
1. Only pause in emergencies
2. Feature flag to bypass splitter
3. Fallback to direct payments

### Scenario C: Endpoint Rejects Transfer

**Risk:** If endpoint is a contract that reverts on receive

**Mitigation:**
1. Use SafeERC20 (already implemented)
2. Test with contract endpoints
3. Whitelist known-good endpoints

---

## 7. Gas Cost Analysis

### Current Settlement
- Permit2 transfer: ~55,000 gas

### New Settlement
- Permit2 transfer: ~55,000 gas
- splitPayment: ~65,000 gas (2 transfers)
- **Total:** ~120,000 gas

### Cost Comparison (at 0.01 gwei)
- Current: ~$0.0011
- New: ~$0.0024
- **Overhead:** ~$0.0013 per settlement

### Break-Even
Fee collection is profitable for payments > ~$1.30 at 0.1% fee rate.

---

## 8. Integration Tests Needed

### Unit Tests (Facilitator)
- [ ] Settlement with fee splitter enabled
- [ ] Settlement with fee splitter disabled (bypass)
- [ ] splitPayment failure handling
- [ ] Correct recipient extraction from requirements

### E2E Tests (Full Flow)
- [ ] Client → 402 → Pay → Verify → Split → Data
- [ ] Multiple tokens (USDC, WETH, BACK)
- [ ] Fee-exempt token (BACK)
- [ ] Large payment
- [ ] Small payment (fee rounds to 0)

### Testnet Verification
- [x] Deploy to Base Sepolia ✅
- [x] Test 0% fee ✅
- [x] Test 0.1% fee ✅
- [x] Test 0.25% fee ✅
- [x] Verify on Basescan ✅
- [ ] Full E2E with facilitator

---

## 9. Rollout Plan

### Phase 1: Testnet E2E
1. Update facilitator to call splitPayment
2. Update x402 server to use splitter payTo
3. Run full E2E test on Sepolia

### Phase 2: Mainnet Soft Launch
1. Deploy fee splitter to mainnet
2. Configure conservative maxSettlementAmount ($100)
3. Enable for single endpoint first
4. Monitor for 24 hours

### Phase 3: Full Rollout
1. Increase maxSettlementAmount
2. Enable for all endpoints
3. Monitor fee collection

### Rollback Plan
1. Set FEE_SPLITTER_ENABLED=false
2. x402 server reverts to direct payTo
3. No funds at risk (new payments go direct)

---

## 10. Monitoring & Alerts

### Metrics to Track
- Settlements per hour
- Fees collected per token
- Failed settlements
- Splitter contract balance (should be ~0)

### Alerts
- Splitter balance > 0 for > 5 minutes
- Settlement failure rate > 5%
- Gas price spike affecting settlements

---

## Summary

### Before Mainnet
1. ✅ Contract deployed and verified on testnet
2. ✅ Fee calculations verified (0%, 0.1%, 0.25%)
3. ⬜ Facilitator integration code
4. ⬜ x402 server payTo update
5. ⬜ Full E2E test on testnet
6. ⬜ Failure scenario testing
7. ⬜ Gas cost profiling

### Confidence Level
- Contract logic: **HIGH** (33 unit tests + 3 testnet tests)
- Integration: **PENDING** (need E2E test)
- Production readiness: **PENDING** (need facilitator + server updates)
