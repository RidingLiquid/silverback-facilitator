/**
 * Fee Splitter Logic Tests
 *
 * These tests verify the fee calculation logic that will be used
 * in both the smart contract and the facilitator service.
 *
 * Run: npx ts-node src/__tests__/fee-splitter-logic.test.ts
 */

// ============================================================================
// Fee Configuration (matches contract)
// ============================================================================

const TOKEN_FEES: Record<string, number> = {
  // Fee-exempt (0%)
  '0x558881c4959e9cf961a7e1815fcd6586906babd2': 0, // BACK (lowercase)

  // Stablecoins (0.1% = 10 bps)
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 10, // USDC (lowercase)
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': 10, // USDT
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 10, // DAI
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 10, // USDbC

  // Ecosystem (0.1% = 10 bps)
  '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b': 10, // VIRTUAL

  // Blue-chips (0.25% = 25 bps)
  '0x4200000000000000000000000000000000000006': 25, // WETH
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 25, // cbBTC (lowercase)
};

const DEFAULT_FEE_BPS = 10;
const MAX_FEE_BPS = 1000; // 10%

// ============================================================================
// Fee Calculation Logic (matches contract)
// ============================================================================

function getTokenFee(tokenAddress: string): number {
  const fee = TOKEN_FEES[tokenAddress.toLowerCase()];
  // If explicitly configured (including 0), use it; otherwise use default
  return fee !== undefined ? fee : DEFAULT_FEE_BPS;
}

function calculateSplit(
  tokenAddress: string,
  amount: bigint
): { netAmount: bigint; feeAmount: bigint } {
  const feeBps = getTokenFee(tokenAddress);
  const feeAmount = (amount * BigInt(feeBps)) / 10000n;
  const netAmount = amount - feeAmount;
  return { netAmount, feeAmount };
}

// ============================================================================
// Test Runner
// ============================================================================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, passed: true });
    console.log(`  ✅ ${name}`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    results.push({ name, passed: false, error: errorMsg });
    console.log(`  ❌ ${name}: ${errorMsg}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(
      message || `Expected ${expected}, got ${actual}`
    );
  }
}

function assertTrue(value: boolean, message?: string): void {
  if (!value) {
    throw new Error(message || 'Expected true');
  }
}

// ============================================================================
// Tests
// ============================================================================

console.log('\n🧪 Fee Splitter Logic Tests\n');

console.log('📋 Fee Configuration:');
test('BACK token is fee-exempt (0%)', () => {
  assertEqual(getTokenFee('0x558881c4959e9cf961a7E1815FCD6586906babd2'), 0);
});

test('USDC has 0.1% fee (10 bps)', () => {
  assertEqual(getTokenFee('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), 10);
});

test('WETH has 0.25% fee (25 bps)', () => {
  assertEqual(getTokenFee('0x4200000000000000000000000000000000000006'), 25);
});

test('Unknown token uses default fee', () => {
  assertEqual(getTokenFee('0x0000000000000000000000000000000000000000'), DEFAULT_FEE_BPS);
});

console.log('\n💰 Fee Calculations:');

test('USDC: 1,000,000 units (1 USDC) → 0.1% fee', () => {
  const { netAmount, feeAmount } = calculateSplit(
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    1_000_000n
  );
  assertEqual(feeAmount, 1000n, 'Fee should be 1000 units (0.001 USDC)');
  assertEqual(netAmount, 999_000n, 'Net should be 999,000 units');
});

test('BACK: 100 ETH → 0% fee (exempt)', () => {
  const amount = 100n * 10n ** 18n;
  const { netAmount, feeAmount } = calculateSplit(
    '0x558881c4959e9cf961a7E1815FCD6586906babd2',
    amount
  );
  assertEqual(feeAmount, 0n, 'Fee should be 0');
  assertEqual(netAmount, amount, 'Net should be full amount');
});

test('WETH: 1 ETH → 0.25% fee', () => {
  const amount = 10n ** 18n; // 1 WETH
  const { netAmount, feeAmount } = calculateSplit(
    '0x4200000000000000000000000000000000000006',
    amount
  );
  const expectedFee = amount * 25n / 10000n;
  assertEqual(feeAmount, expectedFee, 'Fee should be 0.25%');
  assertEqual(netAmount, amount - expectedFee, 'Net should be amount - fee');
});

test('Small amount: 99 units → fee rounds to 0', () => {
  const { netAmount, feeAmount } = calculateSplit(
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    99n
  );
  // 99 * 10 / 10000 = 0.099 → rounds down to 0
  assertEqual(feeAmount, 0n, 'Fee should round down to 0');
  assertEqual(netAmount, 99n, 'Net should be full amount');
});

test('Large amount: 1M USDC → correct fee', () => {
  const amount = 1_000_000_000_000n; // 1M USDC (6 decimals)
  const { netAmount, feeAmount } = calculateSplit(
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // lowercase
    amount
  );
  // 1M USDC = 1,000,000 * 10^6 = 1_000_000_000_000 units
  // 0.1% = 1_000_000_000_000 * 10 / 10000 = 1_000_000_000 units = 1000 USDC fee
  assertEqual(feeAmount, 1_000_000_000n, 'Fee should be $1000 (1B units)');
  assertEqual(netAmount, 999_000_000_000n, 'Net should be $999,000');
});

console.log('\n🔒 Security Validations:');

test('Fee cannot exceed MAX_FEE_BPS (10%)', () => {
  for (const [_, fee] of Object.entries(TOKEN_FEES)) {
    assertTrue(fee <= MAX_FEE_BPS, `Fee ${fee} exceeds max ${MAX_FEE_BPS}`);
  }
});

test('Amount conservation: net + fee = original', () => {
  const testAmounts = [1n, 100n, 1000n, 1_000_000n, 10n ** 18n, 10n ** 24n];
  const testTokens = Object.keys(TOKEN_FEES);

  for (const amount of testAmounts) {
    for (const token of testTokens) {
      const { netAmount, feeAmount } = calculateSplit(token, amount);
      assertEqual(
        netAmount + feeAmount,
        amount,
        `Conservation failed for ${amount} of ${token}`
      );
    }
  }
});

test('Fee calculation is deterministic', () => {
  const amount = 1_000_000n;
  const token = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

  const result1 = calculateSplit(token, amount);
  const result2 = calculateSplit(token, amount);

  assertEqual(result1.feeAmount, result2.feeAmount);
  assertEqual(result1.netAmount, result2.netAmount);
});

console.log('\n📊 Real-World Scenarios:');

test('$0.001 payment (1000 units USDC) → 1 unit fee', () => {
  const { feeAmount } = calculateSplit(
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    1000n // $0.001 in USDC (6 decimals)
  );
  assertEqual(feeAmount, 1n);
});

test('$0.01 payment (10000 units USDC) → 10 unit fee', () => {
  const { feeAmount } = calculateSplit(
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    10_000n
  );
  assertEqual(feeAmount, 10n);
});

test('$1.00 payment (1M units USDC) → 1000 unit fee ($0.001)', () => {
  const { feeAmount } = calculateSplit(
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    1_000_000n
  );
  assertEqual(feeAmount, 1000n);
});

test('$100 payment → $0.10 fee (0.1%)', () => {
  const { feeAmount } = calculateSplit(
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    100_000_000n // $100 in USDC
  );
  assertEqual(feeAmount, 100_000n); // $0.10
});

// ============================================================================
// Summary
// ============================================================================

console.log('\n' + '─'.repeat(50));
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;

if (failed === 0) {
  console.log(`\n✅ All ${passed} tests passed!\n`);
  process.exit(0);
} else {
  console.log(`\n❌ ${failed} tests failed, ${passed} passed\n`);
  console.log('Failed tests:');
  results
    .filter((r) => !r.passed)
    .forEach((r) => console.log(`  - ${r.name}: ${r.error}`));
  process.exit(1);
}
