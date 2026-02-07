/**
 * Settlement Service
 *
 * Executes payments on-chain via Permit2 or ERC-3009.
 * Supports database persistence and webhook notifications.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import type {
  PaymentPayload,
  PaymentRequirements,
  SettlementResult,
} from '../types';
import {
  computeWitnessHash,
  WITNESS_TYPE_STRING,
  PERMIT2_ABI,
} from '../utils/permit2';
import {
  getNetworkConfig,
  PERMIT2_ADDRESS,
  FACILITATOR_CONFIG,
  FEE_SPLITTER_CONFIG,
  parseCaip2,
} from '../config/networks';
import {
  getTokenFeePercent,
  calculateFeeAmount,
  getTokenByAddress,
  isTokenWhitelisted,
} from '../config/tokens';
import { redactAddress, validateAmount } from '../utils/security';
import { verifySignature } from './signature';
import { hasSufficientBalance, hasPermit2Approval } from './balance';
import {
  createTransaction,
  updateTransaction,
  getTransactionStats as dbGetStats,
  getRecentTransactions as dbGetRecent,
  isNonceUsed as dbIsNonceUsed,
  markNonceUsed,
  isUsingPostgres,
} from './database';
import { notifySettlementSuccess, notifySettlementFailed } from './webhook';
import {
  extractErc3009Payload,
  verifyErc3009Payment,
  settleErc3009Payment,
  isErc3009Token,
  detectPayloadProtocol,
} from './erc3009';
import {
  isFeeSplitterEnabled,
  getFeeSplitterAddress,
  executeSplitPayment,
} from './fee-splitter';

// ============================================================================
// In-Memory Fallback (when database not available)
// ============================================================================

const memoryNonces = new Set<string>();
const memoryLog: Array<{
  nonce: string;
  payer: string;
  receiver: string;
  token: string;
  amount: string;
  fee: string;
  txHash: string;
  timestamp: Date;
  protocol: 'permit2' | 'erc3009';
}> = [];

// ============================================================================
// Protocol Detection
// ============================================================================

/**
 * Detect which protocol to use for settlement
 *
 * Priority:
 * 1. If payload is explicitly ERC-3009 format, use ERC-3009
 * 2. If token supports ERC-3009 (like USDC), prefer ERC-3009
 * 3. Otherwise, use Permit2
 */
function detectProtocol(
  payload: PaymentPayload,
  tokenAddress: string,
  network: string
): 'permit2' | 'erc3009' {
  // Check if payload is ERC-3009 format
  const innerPayload = payload.payload as unknown;
  const protocol = detectPayloadProtocol(innerPayload);

  if (protocol === 'erc3009') {
    return 'erc3009';
  }

  // For USDC and other ERC-3009 tokens, we could use ERC-3009
  // But if the payload is Permit2 format, use Permit2
  if (protocol === 'permit2') {
    return 'permit2';
  }

  // Default to Permit2 (works with any token)
  return 'permit2';
}

// ============================================================================
// Unified Settlement
// ============================================================================

/**
 * Execute a payment settlement on-chain
 *
 * Automatically detects whether to use Permit2 or ERC-3009 based on:
 * 1. Payload format
 * 2. Token support
 */
export async function settlePayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements
): Promise<SettlementResult & { fee?: bigint; protocol?: string; transactionId?: string }> {
  const startTime = Date.now();

  // Get network config
  const networkConfig = getNetworkConfig(payload.network);
  if (!networkConfig) {
    return {
      success: false,
      error: `Unsupported network: ${payload.network}`,
    };
  }

  const parsedNetwork = parseCaip2(payload.network);
  const chainId = parsedNetwork?.chainId || 8453;

  // Determine token address and amount based on payload format
  let tokenAddress: `0x${string}`;
  let amount: bigint;
  let receiver: `0x${string}`;
  let payer: `0x${string}`;
  let nonce: string;

  // Check for ERC-3009 payload format
  const erc3009Payload = extractErc3009Payload(payload);

  if (erc3009Payload) {
    // ERC-3009 format
    tokenAddress = requirements.asset as `0x${string}` || requirements.token as `0x${string}`;
    amount = BigInt(erc3009Payload.authorization.value);
    receiver = erc3009Payload.authorization.to;
    payer = erc3009Payload.authorization.from;
    nonce = erc3009Payload.authorization.nonce;

    return await settleErc3009(
      erc3009Payload,
      tokenAddress,
      payload.network,
      requirements,
      chainId
    );
  }

  // Permit2 format
  const { authorization, witness, signature } = payload.payload;
  tokenAddress = authorization.permitted.token;
  receiver = (witness.receiver || witness.to) as `0x${string}`;
  nonce = authorization.nonce;

  // SECURITY: Validate amount with bounds checking before any processing
  const amountValidation = validateAmount(authorization.permitted.amount);
  if (!amountValidation.valid) {
    return {
      success: false,
      error: `Invalid amount: ${amountValidation.error}`,
    };
  }
  amount = amountValidation.amount!;

  // SECURITY: Re-check token whitelist at settlement time
  if (!isTokenWhitelisted(tokenAddress)) {
    return {
      success: false,
      error: `Token ${redactAddress(tokenAddress)} is not whitelisted`,
    };
  }

  // Verify signature
  const verifyResult = await verifySignature(payload, requirements);
  if (!verifyResult.isValid) {
    return {
      success: false,
      error: `Verification failed: ${verifyResult.error} - ${verifyResult.details}`,
    };
  }
  payer = verifyResult.payer!;

  // Check nonce
  const nonceUsed = await checkNonceUsed(payer, nonce);
  if (nonceUsed) {
    return {
      success: false,
      error: 'Nonce already used (replay attack prevented)',
    };
  }

  // Check balance
  const balanceCheck = await hasSufficientBalance(payer, tokenAddress, amount, payload.network);
  if (!balanceCheck.sufficient) {
    return {
      success: false,
      error: `Insufficient balance: has ${balanceCheck.balance}, needs ${amount}`,
    };
  }

  // Check Permit2 approval
  const hasApproval = await hasPermit2Approval(payer, tokenAddress, amount, payload.network);
  if (!hasApproval) {
    return {
      success: false,
      error: 'Permit2 not approved for this token amount',
    };
  }

  // Calculate fee
  const feePercent = getTokenFeePercent(tokenAddress);
  const feeAmount = calculateFeeAmount(amount, feePercent);
  const tokenInfo = getTokenByAddress(tokenAddress);

  // Create transaction record
  const transactionId = await createTransaction({
    nonce,
    payer,
    receiver,
    token_address: tokenAddress,
    token_symbol: tokenInfo?.symbol || 'UNKNOWN',
    amount: amount.toString(),
    fee: feeAmount.toString(),
    fee_percent: feePercent,
    network: payload.network,
    tx_hash: null,
    status: 'pending',
    error_reason: null,
    protocol: 'permit2',
  });

  // Get facilitator wallet
  const facilitatorPrivateKey = process.env.FACILITATOR_PRIVATE_KEY;
  if (!facilitatorPrivateKey) {
    await updateTransaction(transactionId, { status: 'failed', error_reason: 'Facilitator not configured' });
    return {
      success: false,
      error: 'Facilitator wallet not configured',
      transactionId,
    };
  }

  const facilitatorAccount = privateKeyToAccount(facilitatorPrivateKey as `0x${string}`);

  // Create clients
  const publicClient = createPublicClient({
    chain: base,
    transport: http(networkConfig.rpcUrl),
  });

  const walletClient = createWalletClient({
    account: facilitatorAccount,
    chain: base,
    transport: http(networkConfig.rpcUrl),
  });

  // Compute witness hash
  const witnessHash = computeWitnessHash(witness);

  // ============================================================================
  // Fee Splitter Integration
  // ============================================================================
  // Determine if we should use the fee splitter for this settlement
  const useFeeSplitter = isFeeSplitterEnabled(chainId);
  const feeSplitterAddress = useFeeSplitter ? getFeeSplitterAddress(chainId) : null;

  console.log(`[Settlement] Fee Splitter Debug: chainId=${chainId}, enabled=${useFeeSplitter}, address=${feeSplitterAddress}`);

  // When using fee splitter:
  // - payTo (in 402 response) = fee splitter address
  // - actualRecipient (in extra) = endpoint wallet that should receive funds
  // - The client signs Permit2 with receiver = payTo = fee splitter
  // - We then call splitPayment to route funds to actualRecipient
  //
  // NOTE: x402 SDK strips extra.actualRecipient during buildPaymentRequirements(),
  // so we fall back to FEE_SPLITTER_CONFIG.defaultTreasury when not present.
  // This is the configured treasury address (usually X402_WALLET_ADDRESS).
  const actualRecipient = useFeeSplitter
    ? (requirements.extra?.actualRecipient as `0x${string}` || FEE_SPLITTER_CONFIG.defaultTreasury)
    : receiver;

  // Permit2 transfer target:
  // - If fee splitter enabled: transfer to fee splitter (receiver from witness = payTo = splitter)
  // - If fee splitter disabled: transfer directly to receiver (original behavior)
  // Note: receiver here comes from witness, which should match payTo in requirements
  const permit2Receiver = receiver; // Always use witness receiver (what client signed)

  console.log(
    `[Settlement] Permit2: ${amount} tokens from ${redactAddress(payer)} to ${redactAddress(permit2Receiver)}` +
    (useFeeSplitter ? ` (via FeeSplitter → ${redactAddress(actualRecipient)})` : '')
  );

  let transactionHash: `0x${string}`;

  try {
    // Simulate first
    await publicClient.simulateContract({
      address: PERMIT2_ADDRESS,
      abi: PERMIT2_ABI,
      functionName: 'permitWitnessTransferFrom',
      args: [
        {
          permitted: { token: tokenAddress, amount },
          nonce: BigInt(authorization.nonce),
          deadline: BigInt(authorization.deadline),
        },
        { to: permit2Receiver, requestedAmount: amount },
        payer,
        witnessHash,
        WITNESS_TYPE_STRING,
        signature,
      ],
      account: facilitatorAccount,
    });

    // Submit transaction
    transactionHash = await walletClient.writeContract({
      address: PERMIT2_ADDRESS,
      abi: PERMIT2_ABI,
      functionName: 'permitWitnessTransferFrom',
      args: [
        {
          permitted: { token: tokenAddress, amount },
          nonce: BigInt(authorization.nonce),
          deadline: BigInt(authorization.deadline),
        },
        { to: permit2Receiver, requestedAmount: amount },
        payer,
        witnessHash,
        WITNESS_TYPE_STRING,
        signature,
      ],
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Settlement] Permit2 transaction failed:', errorMsg);
    await updateTransaction(transactionId, { status: 'failed', error_reason: errorMsg });

    // Send webhook
    await notifySettlementFailed({
      transactionId,
      payer,
      receiver,
      token: tokenInfo?.symbol || tokenAddress,
      amount: amount.toString(),
      fee: feeAmount.toString(),
      network: payload.network,
      errorReason: errorMsg,
    });

    return {
      success: false,
      error: `Permit2 transaction failed: ${errorMsg}`,
      transactionId,
    };
  }

  // Update transaction with Permit2 hash
  await updateTransaction(transactionId, { tx_hash: transactionHash });
  console.log(`[Settlement] Permit2 submitted: ${transactionHash}`);

  // Wait for Permit2 confirmation
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: transactionHash,
    confirmations: networkConfig.confirmations,
    timeout: FACILITATOR_CONFIG.settlementTimeoutMs,
  });

  if (receipt.status !== 'success') {
    await updateTransaction(transactionId, { status: 'failed', error_reason: 'Permit2 transaction reverted' });

    await notifySettlementFailed({
      transactionId,
      payer,
      receiver,
      token: tokenInfo?.symbol || tokenAddress,
      amount: amount.toString(),
      fee: feeAmount.toString(),
      network: payload.network,
      errorReason: 'Permit2 transaction reverted',
    });

    return {
      success: false,
      error: 'Permit2 transaction reverted',
      transactionId,
    };
  }

  console.log(`[Settlement] Permit2 confirmed in block ${receipt.blockNumber}`);

  // ============================================================================
  // Fee Splitter: Split Payment (if enabled)
  // ============================================================================
  let splitTxHash: `0x${string}` | undefined;
  let actualFeeAmount = feeAmount;

  if (useFeeSplitter && feeSplitterAddress) {
    console.log(`[Settlement] Executing fee split to ${redactAddress(actualRecipient)}...`);

    const splitResult = await executeSplitPayment({
      token: tokenAddress,
      payer,
      recipient: actualRecipient,
      amount,
      network: payload.network,
    });

    if (!splitResult.success) {
      // CRITICAL: Permit2 succeeded but splitPayment failed
      // Funds are stuck in the fee splitter contract
      // Mark as failed but preserve the Permit2 hash for recovery
      console.error('[Settlement] CRITICAL: splitPayment failed after Permit2 succeeded!');
      console.error(`[Settlement] Permit2 hash: ${transactionHash}`);
      console.error(`[Settlement] Error: ${splitResult.error}`);

      await updateTransaction(transactionId, {
        status: 'failed',
        error_reason: `splitPayment failed: ${splitResult.error}. Funds in splitter need recovery. Permit2: ${transactionHash}`,
      });

      await notifySettlementFailed({
        transactionId,
        payer,
        receiver,
        token: tokenInfo?.symbol || tokenAddress,
        amount: amount.toString(),
        fee: feeAmount.toString(),
        network: payload.network,
        errorReason: `splitPayment failed after Permit2. Recovery needed. Error: ${splitResult.error}`,
      });

      return {
        success: false,
        error: `splitPayment failed: ${splitResult.error}. Permit2 succeeded (${transactionHash}), funds need recovery.`,
        transactionId,
      };
    }

    splitTxHash = splitResult.transactionHash;
    actualFeeAmount = splitResult.feeAmount || feeAmount;

    console.log(
      `[Settlement] Split complete! Net: ${splitResult.netAmount}, Fee: ${actualFeeAmount}, TX: ${splitTxHash}`
    );
  }

  // Mark success
  await updateTransaction(transactionId, { status: 'success', settled_at: new Date() });
  await recordNonceUsed(payer, nonce, tokenAddress, transactionHash);

  // Log to memory as well (for getRecentSettlements when not using DB)
  // Use actualRecipient when fee splitter is enabled (that's where funds went)
  const finalReceiver = useFeeSplitter ? actualRecipient : receiver;

  memoryLog.push({
    nonce,
    payer,
    receiver: finalReceiver,
    token: tokenInfo?.symbol || tokenAddress,
    amount: amount.toString(),
    fee: actualFeeAmount.toString(),
    txHash: splitTxHash || transactionHash,
    timestamp: new Date(),
    protocol: 'permit2',
  });

  console.log(
    `[Settlement] Success! Permit2: ${transactionHash}` +
    (splitTxHash ? `, Split: ${splitTxHash}` : '') +
    `, Block: ${receipt.blockNumber}`
  );

  // Send webhook
  await notifySettlementSuccess({
    transactionId,
    txHash: splitTxHash || transactionHash,
    payer,
    receiver: finalReceiver,
    token: tokenInfo?.symbol || tokenAddress,
    amount: amount.toString(),
    fee: actualFeeAmount.toString(),
    network: payload.network,
  });

  return {
    success: true,
    transactionHash: splitTxHash || transactionHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    payer,  // x402 spec requires payer in response
    fee: actualFeeAmount,
    protocol: 'permit2',
    transactionId,
  };
}

// ============================================================================
// ERC-3009 Settlement
// ============================================================================

async function settleErc3009(
  erc3009Payload: { signature: `0x${string}`; authorization: { from: `0x${string}`; to: `0x${string}`; value: string; validAfter: number; validBefore: number; nonce: string } },
  tokenAddress: `0x${string}`,
  network: string,
  requirements: PaymentRequirements,
  chainId: number
): Promise<SettlementResult & { fee?: bigint; protocol?: string; transactionId?: string }> {
  const { authorization } = erc3009Payload;
  const amount = BigInt(authorization.value);
  const payer = authorization.from;
  const receiver = authorization.to;
  const nonce = authorization.nonce;

  // Verify ERC-3009 signature
  const verifyResult = await verifyErc3009Payment(erc3009Payload, tokenAddress, requirements, chainId, network);
  if (!verifyResult.isValid) {
    return {
      success: false,
      error: `ERC-3009 verification failed: ${verifyResult.error} - ${verifyResult.details}`,
    };
  }

  // Check nonce
  const nonceUsed = await checkNonceUsed(payer, nonce);
  if (nonceUsed) {
    return {
      success: false,
      error: 'Nonce already used (replay attack prevented)',
    };
  }

  // Calculate fee
  const feePercent = getTokenFeePercent(tokenAddress);
  const feeAmount = calculateFeeAmount(amount, feePercent);
  const tokenInfo = getTokenByAddress(tokenAddress);

  // Create transaction record
  const transactionId = await createTransaction({
    nonce,
    payer,
    receiver,
    token_address: tokenAddress,
    token_symbol: tokenInfo?.symbol || 'UNKNOWN',
    amount: amount.toString(),
    fee: feeAmount.toString(),
    fee_percent: feePercent,
    network,
    tx_hash: null,
    status: 'pending',
    error_reason: null,
    protocol: 'erc3009',
  });

  console.log(`[Settlement] ERC-3009: ${amount} tokens from ${redactAddress(payer)} to ${redactAddress(receiver)}`);

  // Execute ERC-3009 settlement
  const result = await settleErc3009Payment(erc3009Payload, tokenAddress, network);

  if (!result.success) {
    await updateTransaction(transactionId, { status: 'failed', error_reason: result.error });

    await notifySettlementFailed({
      transactionId,
      payer,
      receiver,
      token: tokenInfo?.symbol || tokenAddress,
      amount: amount.toString(),
      fee: feeAmount.toString(),
      network,
      errorReason: result.error || 'Unknown error',
    });

    return { ...result, protocol: 'erc3009', transactionId };
  }

  // Mark success
  await updateTransaction(transactionId, {
    status: 'success',
    tx_hash: result.transactionHash,
    settled_at: new Date(),
  });
  await recordNonceUsed(payer, nonce, tokenAddress, result.transactionHash!);

  // Log to memory
  memoryLog.push({
    nonce,
    payer,
    receiver,
    token: tokenInfo?.symbol || tokenAddress,
    amount: amount.toString(),
    fee: feeAmount.toString(),
    txHash: result.transactionHash!,
    timestamp: new Date(),
    protocol: 'erc3009',
  });

  // Send webhook
  await notifySettlementSuccess({
    transactionId,
    txHash: result.transactionHash!,
    payer,
    receiver,
    token: tokenInfo?.symbol || tokenAddress,
    amount: amount.toString(),
    fee: feeAmount.toString(),
    network,
  });

  return {
    ...result,
    fee: feeAmount,
    protocol: 'erc3009',
    transactionId,
  };
}

// ============================================================================
// Nonce Helpers
// ============================================================================

async function checkNonceUsed(payer: string, nonce: string): Promise<boolean> {
  const key = `${payer.toLowerCase()}:${nonce}`;

  // Check memory first (fast)
  if (memoryNonces.has(key)) {
    return true;
  }

  // Check database
  return await dbIsNonceUsed(payer, nonce);
}

async function recordNonceUsed(
  payer: string,
  nonce: string,
  tokenAddress: string,
  txHash: string
): Promise<void> {
  const key = `${payer.toLowerCase()}:${nonce}`;
  memoryNonces.add(key);
  await markNonceUsed(payer, nonce, tokenAddress, txHash);
}

// ============================================================================
// Legacy API (for backwards compatibility)
// ============================================================================

/**
 * Execute settlement with fee (wrapper for backwards compatibility)
 */
export async function settlePaymentWithFee(
  payload: PaymentPayload,
  requirements: PaymentRequirements
): Promise<SettlementResult & { fee?: bigint }> {
  return await settlePayment(payload, requirements);
}

/**
 * Check if a nonce has been used
 */
export async function isNonceUsed(payer: string, nonce: string): Promise<boolean> {
  return await checkNonceUsed(payer, nonce);
}

/**
 * Get recent settlements
 */
export async function getRecentSettlements(limit: number = 100) {
  if (isUsingPostgres()) {
    return await dbGetRecent(limit);
  }
  return memoryLog.slice(-limit);
}

/**
 * Get settlement statistics
 */
export async function getSettlementStats() {
  if (isUsingPostgres()) {
    return await dbGetStats();
  }

  // In-memory stats
  const totalSettlements = memoryLog.length;
  const totalVolume = memoryLog.reduce((sum, s) => sum + BigInt(s.amount), 0n);
  const totalFees = memoryLog.reduce((sum, s) => sum + BigInt(s.fee), 0n);

  const volumeByToken: Record<string, bigint> = {};
  for (const s of memoryLog) {
    volumeByToken[s.token] = (volumeByToken[s.token] || 0n) + BigInt(s.amount);
  }

  return {
    total: totalSettlements,
    successful: totalSettlements, // All in memory are successful
    failed: 0,
    pending: 0,
    totalVolume: totalVolume.toString(),
    totalFees: totalFees.toString(),
    volumeByToken: Object.fromEntries(
      Object.entries(volumeByToken).map(([k, v]) => [k, v.toString()])
    ),
  };
}
