/**
 * ERC-3009 Service
 *
 * Implements transferWithAuthorization for USDC and other ERC-3009 tokens.
 * This provides compatibility with clients that use ERC-3009 instead of Permit2.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseSignature,
  recoverTypedDataAddress,
  keccak256,
  encodePacked,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import type { PaymentPayload, PaymentRequirements, SettlementResult } from '../types';
import { getNetworkConfig, FACILITATOR_CONFIG } from '../config/networks';
import { getTokenByAddress, getTokenFeePercent, calculateFeeAmount } from '../config/tokens';

// ============================================================================
// ERC-3009 Token Registry
// ============================================================================

/**
 * Tokens that support ERC-3009 (transferWithAuthorization)
 * These tokens have native gasless transfer support
 *
 * Structure: network -> tokenAddress -> { name, domainName, domainVersion }
 */
export const ERC3009_TOKENS: Record<string, Record<string, {
  name: string;
  domainName: string;
  domainVersion: string;
}>> = {
  // Base Mainnet
  'eip155:8453': {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': {
      name: 'USDC',
      domainName: 'USD Coin',
      domainVersion: '2',
    },
  },
  // Base Sepolia (testnet)
  'eip155:84532': {
    '0x036cbd53842c5426634e7929541ec2318f3dcf7e': {
      name: 'USDC',
      domainName: 'USD Coin',
      domainVersion: '2',
    },
  },
};

// Aliases for Coinbase network format
ERC3009_TOKENS['base'] = ERC3009_TOKENS['eip155:8453'];
ERC3009_TOKENS['base-sepolia'] = ERC3009_TOKENS['eip155:84532'];

/**
 * Check if a token supports ERC-3009 on the given network
 */
export function isErc3009Token(tokenAddress: string, network: string): boolean {
  const normalizedNetwork = normalizeNetworkForErc3009(network);
  const networkTokens = ERC3009_TOKENS[normalizedNetwork];
  if (!networkTokens) return false;
  return tokenAddress.toLowerCase() in networkTokens;
}

/**
 * Get ERC-3009 token info
 */
export function getErc3009TokenInfo(tokenAddress: string, network: string): {
  name: string;
  domainName: string;
  domainVersion: string;
} | null {
  const normalizedNetwork = normalizeNetworkForErc3009(network);
  const networkTokens = ERC3009_TOKENS[normalizedNetwork];
  if (!networkTokens) return null;
  return networkTokens[tokenAddress.toLowerCase()] || null;
}

/**
 * Normalize network identifier for ERC-3009 lookup
 */
function normalizeNetworkForErc3009(network: string): string {
  // Support both Coinbase format and CAIP-2
  if (network === 'base' || network === 'base-mainnet') return 'eip155:8453';
  if (network === 'base-sepolia') return 'eip155:84532';
  return network;
}

// ============================================================================
// ERC-3009 Types
// ============================================================================

export interface Erc3009Authorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: number;
  validBefore: number;
  nonce: string;
}

export interface Erc3009Payload {
  signature: `0x${string}`;
  authorization: Erc3009Authorization;
}

// ============================================================================
// ERC-3009 ABI
// ============================================================================

const ERC3009_ABI = [
  {
    name: 'transferWithAuthorization',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'authorizationState',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'DOMAIN_SEPARATOR',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const;

// ============================================================================
// ERC-3009 EIP-712 Types
// ============================================================================

const ERC3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/**
 * Build EIP-712 domain for a specific ERC-3009 token
 */
function buildErc3009Domain(tokenAddress: string, chainId: number, network: string) {
  const tokenInfo = getErc3009TokenInfo(tokenAddress, network);

  return {
    name: tokenInfo?.domainName || 'USD Coin',
    version: tokenInfo?.domainVersion || '2',
    chainId,
    verifyingContract: tokenAddress as `0x${string}`,
  };
}

// ============================================================================
// Signature Recovery
// ============================================================================

/**
 * Recover signer from ERC-3009 authorization
 */
export async function recoverErc3009Signer(
  payload: Erc3009Payload,
  tokenAddress: string,
  chainId: number,
  network: string = 'eip155:8453'
): Promise<{ address: `0x${string}`; isValid: boolean; error?: string }> {
  try {
    const { signature, authorization } = payload;

    // Build domain for the specific token (dynamic based on token)
    const domain = buildErc3009Domain(tokenAddress, chainId, network);

    // Convert nonce to bytes32 if it's a number string
    let nonceBytes32: `0x${string}`;
    if (authorization.nonce.startsWith('0x') && authorization.nonce.length === 66) {
      nonceBytes32 = authorization.nonce as `0x${string}`;
    } else {
      // Convert numeric nonce to bytes32
      nonceBytes32 = `0x${BigInt(authorization.nonce).toString(16).padStart(64, '0')}` as `0x${string}`;
    }

    const message = {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: nonceBytes32,
    };

    const address = await recoverTypedDataAddress({
      domain,
      types: ERC3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message,
      signature,
    });

    // Verify recovered address matches 'from'
    if (address.toLowerCase() !== authorization.from.toLowerCase()) {
      return {
        address,
        isValid: false,
        error: `Signer ${address} does not match from ${authorization.from}`,
      };
    }

    return { address, isValid: true };
  } catch (error) {
    return {
      address: '0x0000000000000000000000000000000000000000',
      isValid: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================================================
// ERC-3009 Verification
// ============================================================================

/**
 * Verify an ERC-3009 payment
 */
export async function verifyErc3009Payment(
  payload: Erc3009Payload,
  tokenAddress: string,
  requirements: PaymentRequirements,
  chainId: number,
  network: string = 'eip155:8453'
): Promise<{ isValid: boolean; payer?: `0x${string}`; error?: string; details?: string }> {
  try {
    const { authorization } = payload;

    // 1. Check validity window
    const now = Math.floor(Date.now() / 1000);
    if (now < authorization.validAfter) {
      return {
        isValid: false,
        error: 'Authorization not yet valid',
        details: `validAfter is ${authorization.validAfter}, current time is ${now}`,
      };
    }

    if (now >= authorization.validBefore) {
      return {
        isValid: false,
        error: 'Authorization expired',
        details: `validBefore is ${authorization.validBefore}, current time is ${now}`,
      };
    }

    // 2. Recover and verify signer
    const signerResult = await recoverErc3009Signer(payload, tokenAddress, chainId, network);
    if (!signerResult.isValid) {
      return {
        isValid: false,
        error: 'Invalid signature',
        details: signerResult.error,
      };
    }

    // 3. Verify receiver matches payTo
    if (authorization.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
      return {
        isValid: false,
        payer: signerResult.address,
        error: 'Receiver mismatch',
        details: `Authorization to ${authorization.to} does not match payTo ${requirements.payTo}`,
      };
    }

    // 4. Verify amount
    const authAmount = BigInt(authorization.value);
    const requiredAmount = BigInt(requirements.maxAmountRequired);
    if (authAmount < requiredAmount) {
      return {
        isValid: false,
        payer: signerResult.address,
        error: 'Insufficient amount',
        details: `Authorization amount ${authAmount} < required ${requiredAmount}`,
      };
    }

    return {
      isValid: true,
      payer: signerResult.address,
    };
  } catch (error) {
    return {
      isValid: false,
      error: 'Verification failed',
      details: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================================================
// ERC-3009 Settlement
// ============================================================================

/**
 * Execute ERC-3009 settlement
 */
export async function settleErc3009Payment(
  payload: Erc3009Payload,
  tokenAddress: string,
  network: string
): Promise<SettlementResult> {
  try {
    const networkConfig = getNetworkConfig(network);
    if (!networkConfig) {
      return { success: false, error: `Unsupported network: ${network}` };
    }

    const facilitatorPrivateKey = process.env.FACILITATOR_PRIVATE_KEY;
    if (!facilitatorPrivateKey) {
      return { success: false, error: 'Facilitator wallet not configured' };
    }

    const { signature, authorization } = payload;

    // Parse signature into v, r, s
    const { v, r, s } = parseSignature(signature);

    // Convert nonce to bytes32
    let nonceBytes32: `0x${string}`;
    if (authorization.nonce.startsWith('0x') && authorization.nonce.length === 66) {
      nonceBytes32 = authorization.nonce as `0x${string}`;
    } else {
      nonceBytes32 = `0x${BigInt(authorization.nonce).toString(16).padStart(64, '0')}` as `0x${string}`;
    }

    const facilitatorAccount = privateKeyToAccount(facilitatorPrivateKey as `0x${string}`);

    const publicClient = createPublicClient({
      chain: base,
      transport: http(networkConfig.rpcUrl),
    });

    const walletClient = createWalletClient({
      account: facilitatorAccount,
      chain: base,
      transport: http(networkConfig.rpcUrl),
    });

    console.log(`[ERC-3009] Settling payment: ${authorization.value} from ${authorization.from} to ${authorization.to}`);

    // Simulate first
    try {
      await publicClient.simulateContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC3009_ABI,
        functionName: 'transferWithAuthorization',
        args: [
          authorization.from,
          authorization.to,
          BigInt(authorization.value),
          BigInt(authorization.validAfter),
          BigInt(authorization.validBefore),
          nonceBytes32,
          Number(v),
          r,
          s,
        ],
        account: facilitatorAccount,
      });
    } catch (simError) {
      console.error('[ERC-3009] Simulation failed:', simError);
      return {
        success: false,
        error: `Simulation failed: ${simError instanceof Error ? simError.message : 'Unknown error'}`,
      };
    }

    // Execute transaction
    const txHash = await walletClient.writeContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC3009_ABI,
      functionName: 'transferWithAuthorization',
      args: [
        authorization.from,
        authorization.to,
        BigInt(authorization.value),
        BigInt(authorization.validAfter),
        BigInt(authorization.validBefore),
        nonceBytes32,
        Number(v),
        r,
        s,
      ],
    });

    console.log(`[ERC-3009] Transaction submitted: ${txHash}`);

    // Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: networkConfig.confirmations,
      timeout: FACILITATOR_CONFIG.settlementTimeoutMs,
    });

    if (receipt.status !== 'success') {
      return { success: false, error: 'Transaction reverted' };
    }

    console.log(`[ERC-3009] Success! Block: ${receipt.blockNumber}`);

    return {
      success: true,
      transactionHash: txHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
    };
  } catch (error) {
    console.error('[ERC-3009] Settlement error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================================================
// Protocol Detection
// ============================================================================

/**
 * Detect if payload is ERC-3009 or Permit2 format
 */
export function detectPayloadProtocol(payload: unknown): 'erc3009' | 'permit2' | 'unknown' {
  if (!payload || typeof payload !== 'object') return 'unknown';

  const p = payload as Record<string, unknown>;

  // ERC-3009 has authorization with from/to/value directly
  if (p.authorization && typeof p.authorization === 'object') {
    const auth = p.authorization as Record<string, unknown>;
    if ('from' in auth && 'to' in auth && 'value' in auth && !('permitted' in auth)) {
      return 'erc3009';
    }
    // Permit2 has authorization.permitted
    if ('permitted' in auth) {
      return 'permit2';
    }
  }

  // Check for witness (Permit2 specific)
  if ('witness' in p) {
    return 'permit2';
  }

  return 'unknown';
}

/**
 * Convert x402 PaymentPayload to Erc3009Payload if applicable
 */
export function extractErc3009Payload(payload: PaymentPayload): Erc3009Payload | null {
  // Check if this looks like an ERC-3009 payload embedded in x402 format
  const inner = payload.payload as unknown as Record<string, unknown>;

  if (inner.authorization && typeof inner.authorization === 'object') {
    const auth = inner.authorization as Record<string, unknown>;

    // ERC-3009 format: has from, to, value directly (not permitted.token/amount)
    if ('from' in auth && 'to' in auth && 'value' in auth && !('permitted' in auth)) {
      return {
        signature: inner.signature as `0x${string}`,
        authorization: {
          from: auth.from as `0x${string}`,
          to: auth.to as `0x${string}`,
          value: String(auth.value),
          validAfter: Number(auth.validAfter || 0),
          validBefore: Number(auth.validBefore || Math.floor(Date.now() / 1000) + 3600),
          nonce: String(auth.nonce),
        },
      };
    }
  }

  return null;
}
