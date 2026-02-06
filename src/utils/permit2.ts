/**
 * Permit2 Utilities
 *
 * Helper functions for working with Uniswap's Permit2 contract
 * and x402 payment signatures.
 */

import {
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  encodePacked,
  recoverTypedDataAddress,
} from 'viem';
import type { Permit2Payload, Permit2Witness, RecoveredSigner } from '../types';
import { PERMIT2_ADDRESS } from '../config/networks';

// ============================================================================
// EIP-712 Domain & Types for Permit2
// ============================================================================

/**
 * Permit2 EIP-712 domain
 */
export function getPermit2Domain(chainId: number) {
  return {
    name: 'Permit2',
    chainId,
    verifyingContract: PERMIT2_ADDRESS,
  } as const;
}

/**
 * Permit2 PermitWitnessTransferFrom types with x402 witness
 */
export const PERMIT2_TYPES = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'X402TransferDetails' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  X402TransferDetails: [
    { name: 'receiver', type: 'address' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
  ],
} as const;

/**
 * Witness type string for Permit2 (used in contract calls)
 */
export const WITNESS_TYPE_STRING =
  'X402TransferDetails witness)TokenPermissions(address token,uint256 amount)X402TransferDetails(address receiver,uint256 validAfter,uint256 validBefore)';

// ============================================================================
// Signature Recovery
// ============================================================================

/**
 * Recover the signer address from a Permit2 payload
 *
 * Supports both x402 spec naming and our internal naming for compatibility:
 * - witness.receiver (our format) / witness.to (x402 spec)
 * - witness.validBefore (our format) / witness.extra (x402 spec - not used)
 */
export async function recoverPermit2Signer(
  payload: Permit2Payload,
  chainId: number
): Promise<RecoveredSigner> {
  try {
    const { signature, authorization, witness } = payload;

    const domain = getPermit2Domain(chainId);

    // Support both "receiver" (our format) and "to" (x402 spec)
    const receiver = witness.receiver || witness.to;
    if (!receiver) {
      return {
        address: '0x0000000000000000000000000000000000000000',
        isValid: false,
        error: 'Missing receiver/to in witness',
      };
    }

    const message = {
      permitted: {
        token: authorization.permitted.token,
        amount: BigInt(authorization.permitted.amount),
      },
      spender: authorization.spender,
      nonce: BigInt(authorization.nonce),
      deadline: BigInt(authorization.deadline),
      witness: {
        receiver: receiver,
        validAfter: BigInt(witness.validAfter),
        validBefore: BigInt(witness.validBefore),
      },
    };

    const address = await recoverTypedDataAddress({
      domain,
      types: PERMIT2_TYPES,
      primaryType: 'PermitWitnessTransferFrom',
      message,
      signature,
    });

    return {
      address,
      isValid: true,
    };
  } catch (error) {
    return {
      address: '0x0000000000000000000000000000000000000000',
      isValid: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================================================
// Witness Hash Computation
// ============================================================================

/**
 * Compute the witness hash for x402 transfer details
 * This hash is used in the Permit2 contract call
 *
 * EIP-712 hashStruct formula:
 * hashStruct(s) = keccak256(typeHash || encodeData(s))
 *
 * Where typeHash = keccak256(typeString) and encodeData is abi.encode of the struct fields
 */
export function computeWitnessHash(witness: Permit2Witness): `0x${string}` {
  // Get the type hash for X402TransferDetails
  const typeHash = keccak256(
    encodePacked(['string'], ['X402TransferDetails(address receiver,uint256 validAfter,uint256 validBefore)'])
  );

  // abi.encode the witness data (without typeHash)
  const encodedData = encodeAbiParameters(
    parseAbiParameters('address receiver, uint256 validAfter, uint256 validBefore'),
    [witness.receiver, BigInt(witness.validAfter), BigInt(witness.validBefore)]
  );

  // keccak256(typeHash || encodedData) using concat
  return keccak256(
    `${typeHash}${encodedData.slice(2)}` as `0x${string}`
  );
}

/**
 * Compute the witness type hash
 */
export function getWitnessTypeHash(): `0x${string}` {
  return keccak256(
    encodePacked(['string'], ['X402TransferDetails(address receiver,uint256 validAfter,uint256 validBefore)'])
  );
}

// ============================================================================
// Nonce Utilities
// ============================================================================

/**
 * Generate a random nonce for Permit2
 * Permit2 uses unordered nonces (any unused value works)
 */
export function generateNonce(): string {
  // Use timestamp + random for uniqueness
  const timestamp = BigInt(Date.now());
  const random = BigInt(Math.floor(Math.random() * 1000000));
  return (timestamp * 1000000n + random).toString();
}

/**
 * Check if nonce format is valid (numeric string)
 */
export function isValidNonce(nonce: string): boolean {
  try {
    BigInt(nonce);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Deadline Utilities
// ============================================================================

/**
 * Check if deadline has expired
 */
export function isDeadlineExpired(deadline: number): boolean {
  return Math.floor(Date.now() / 1000) > deadline;
}

/**
 * Check if validAfter/validBefore window is valid
 */
export function isWithinValidityWindow(
  validAfter: number,
  validBefore: number
): boolean {
  const now = Math.floor(Date.now() / 1000);
  return now >= validAfter && now < validBefore;
}

/**
 * Generate a deadline N seconds from now
 */
export function generateDeadline(secondsFromNow: number = 300): number {
  return Math.floor(Date.now() / 1000) + secondsFromNow;
}

// ============================================================================
// Permit2 Contract ABIs
// ============================================================================

export const PERMIT2_ABI = [
  // Read functions
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
  },
  {
    name: 'nonceBitmap',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'wordPos', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // Write functions
  {
    name: 'permitWitnessTransferFrom',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'permit',
        type: 'tuple',
        components: [
          {
            name: 'permitted',
            type: 'tuple',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      {
        name: 'transferDetails',
        type: 'tuple',
        components: [
          { name: 'to', type: 'address' },
          { name: 'requestedAmount', type: 'uint256' },
        ],
      },
      { name: 'owner', type: 'address' },
      { name: 'witness', type: 'bytes32' },
      { name: 'witnessTypeString', type: 'string' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

// ============================================================================
// x402Permit2Proxy Contract ABI
// ============================================================================

export const X402_PROXY_ABI = [
  {
    name: 'settle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'permit',
        type: 'tuple',
        components: [
          {
            name: 'permitted',
            type: 'tuple',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      {
        name: 'transferDetails',
        type: 'tuple',
        components: [
          { name: 'to', type: 'address' },
          { name: 'requestedAmount', type: 'uint256' },
        ],
      },
      { name: 'owner', type: 'address' },
      { name: 'witness', type: 'bytes32' },
      { name: 'witnessTypeString', type: 'string' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'PERMIT2',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;
