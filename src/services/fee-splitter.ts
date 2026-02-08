/**
 * Fee Splitter Service
 *
 * Integrates with the X402FeeSplitter contract to split payments
 * between endpoint providers and the treasury.
 *
 * Flow:
 * 1. Permit2 transfers tokens to FeeSplitter contract
 * 2. This service calls splitPayment() to distribute funds
 * 3. Endpoint receives (amount - fee), treasury receives fee
 */

import {
  createPublicClient,
  createWalletClient,
  http,
} from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { FEE_SPLITTER_CONFIG, getNetworkConfig, FACILITATOR_CONFIG } from '../config/networks';

// ============================================================================
// Contract ABI (minimal - only what we need)
// ============================================================================

const FEE_SPLITTER_ABI = [
  {
    name: 'splitPayment',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'payer', type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [
      { name: 'netAmount', type: 'uint256' },
      { name: 'feeAmount', type: 'uint256' },
    ],
  },
  {
    name: 'calculateSplit',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [
      { name: 'netAmount', type: 'uint256' },
      { name: 'feeAmount', type: 'uint256' },
    ],
  },
  {
    name: 'getTokenFee',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'isFacilitator',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'facilitator', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'paused',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

// ============================================================================
// Types
// ============================================================================

export interface SplitPaymentParams {
  token: `0x${string}`;
  payer: `0x${string}`;
  recipient: `0x${string}`;
  amount: bigint;
  network: string;
}

export interface SplitPaymentResult {
  success: boolean;
  transactionHash?: `0x${string}`;
  netAmount?: bigint;
  feeAmount?: bigint;
  error?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

function getChain(chainId: number) {
  if (chainId === 84532) return baseSepolia;
  return base;
}

// ============================================================================
// Settlement Mutex - prevents concurrent settlements sharing a nonce
// ============================================================================

let settlementLock: Promise<void> = Promise.resolve();

/**
 * Serialize settlement operations to prevent nonce collisions.
 * All on-chain writes from the facilitator wallet must go through this lock.
 */
export function withSettlementLock<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const prev = settlementLock;
  settlementLock = next;
  return prev.then(fn).finally(() => release!());
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Check if fee splitter is enabled and available for the given network
 */
export function isFeeSplitterEnabled(chainId: number): boolean {
  return FEE_SPLITTER_CONFIG.isAvailable(chainId);
}

/**
 * Get the fee splitter address for a given chain
 */
export function getFeeSplitterAddress(chainId: number): `0x${string}` {
  return FEE_SPLITTER_CONFIG.getAddress(chainId);
}

/**
 * Execute the payment split on the fee splitter contract
 *
 * This should be called AFTER Permit2 has transferred tokens to the fee splitter.
 * The fee splitter will then distribute:
 * - (amount - fee) to the recipient (endpoint wallet)
 * - fee to the treasury
 */
export async function executeSplitPayment(
  params: SplitPaymentParams
): Promise<SplitPaymentResult> {
  const { token, payer, recipient, amount, network } = params;

  // Get network config
  const networkConfig = getNetworkConfig(network);
  if (!networkConfig) {
    return {
      success: false,
      error: `Unsupported network: ${network}`,
    };
  }

  const chainId = networkConfig.chainId;
  const splitterAddress = getFeeSplitterAddress(chainId);

  if (splitterAddress === '0x0000000000000000000000000000000000000000') {
    return {
      success: false,
      error: 'Fee splitter not configured for this network',
    };
  }

  // Get facilitator wallet
  const facilitatorPrivateKey = process.env.FACILITATOR_PRIVATE_KEY;
  if (!facilitatorPrivateKey) {
    return {
      success: false,
      error: 'Facilitator wallet not configured',
    };
  }

  const facilitatorAccount = privateKeyToAccount(facilitatorPrivateKey as `0x${string}`);
  const chain = getChain(chainId);

  // Create clients
  const publicClient = createPublicClient({
    chain,
    transport: http(networkConfig.rpcUrl),
  });

  const walletClient = createWalletClient({
    account: facilitatorAccount,
    chain,
    transport: http(networkConfig.rpcUrl),
  });

  console.log(
    `[FeeSplitter] Splitting payment: ${amount} tokens to ${recipient.slice(0, 8)}...`
  );

  try {
    // Simulate first
    const { result } = await publicClient.simulateContract({
      address: splitterAddress,
      abi: FEE_SPLITTER_ABI,
      functionName: 'splitPayment',
      args: [token, payer, recipient, amount],
      account: facilitatorAccount,
    });

    const [netAmount, feeAmount] = result as [bigint, bigint];

    // Execute transaction with nonce retry logic
    // "replacement transaction underpriced" happens when a previous tx
    // is still pending in the mempool with the same nonce
    const MAX_RETRIES = 3;
    let hash: `0x${string}` | undefined;
    let lastError: string = '';

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        // Get explicit pending nonce to avoid stale cache
        const nonce = await publicClient.getTransactionCount({
          address: facilitatorAccount.address,
          blockTag: 'pending',
        });

        // Bump gas on retries to replace stuck tx
        const gasOptions = attempt > 0
          ? {
              maxFeePerGas: BigInt(Math.ceil(1_500_000_000 * Math.pow(1.5, attempt))),
              maxPriorityFeePerGas: BigInt(Math.ceil(1_000_000 * Math.pow(2, attempt))),
            }
          : {};

        if (attempt > 0) {
          console.log(`[FeeSplitter] Retry ${attempt}/${MAX_RETRIES} with nonce ${nonce}${attempt > 0 ? ' (bumped gas)' : ''}`);
        }

        hash = await walletClient.writeContract({
          address: splitterAddress,
          abi: FEE_SPLITTER_ABI,
          functionName: 'splitPayment',
          args: [token, payer, recipient, amount],
          nonce,
          ...gasOptions,
        } as any);
        break; // Success, exit retry loop
      } catch (retryError) {
        lastError = retryError instanceof Error ? retryError.message : 'Unknown error';
        const isNonceError = lastError.includes('replacement transaction underpriced') ||
                             lastError.includes('nonce too low') ||
                             lastError.includes('already known');

        if (!isNonceError || attempt >= MAX_RETRIES - 1) {
          throw retryError; // Not a nonce issue or out of retries
        }

        console.warn(`[FeeSplitter] Nonce conflict (attempt ${attempt + 1}): ${lastError.slice(0, 80)}`);
        // Wait for pending tx to clear before retry
        await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
      }
    }

    if (!hash) {
      return {
        success: false,
        error: `splitPayment failed after ${MAX_RETRIES} retries: ${lastError}`,
      };
    }

    console.log(`[FeeSplitter] Transaction submitted: ${hash}`);

    // Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: networkConfig.confirmations,
      timeout: FACILITATOR_CONFIG.settlementTimeoutMs,
    });

    if (receipt.status !== 'success') {
      return {
        success: false,
        error: 'splitPayment transaction reverted',
      };
    }

    console.log(
      `[FeeSplitter] Success! Net: ${netAmount}, Fee: ${feeAmount}, Block: ${receipt.blockNumber}`
    );

    return {
      success: true,
      transactionHash: hash,
      netAmount,
      feeAmount,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[FeeSplitter] Split payment failed:', errorMsg);

    return {
      success: false,
      error: `splitPayment failed: ${errorMsg}`,
    };
  }
}
