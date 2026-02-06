/**
 * x402 Facilitator Types
 *
 * Type definitions for the Silverback x402 Facilitator service
 */

// ============================================================================
// Core x402 Protocol Types
// ============================================================================

export interface PaymentPayload {
  x402Version: number;
  scheme: 'exact';
  network: string; // CAIP-2 format, e.g., 'eip155:8453'
  payload: Permit2Payload;
}

export interface Permit2Payload {
  signature: `0x${string}`;
  authorization: Permit2Authorization;
  witness: Permit2Witness;
}

/**
 * Permit2 Authorization structure
 * Note: Supports both x402 spec naming (permit2Authorization) and our internal naming
 */
export interface Permit2Authorization {
  permitted: {
    token: `0x${string}`;
    amount: string; // BigInt as string
  };
  from?: `0x${string}`; // Payer address (optional, recovered from signature)
  spender: `0x${string}`; // x402Permit2Proxy address (MUST be proxy, not facilitator)
  nonce: string; // BigInt as string
  deadline: number; // Unix timestamp
}

/**
 * Permit2 Witness structure for x402
 *
 * x402 Spec uses: { to, validAfter, extra }
 * We support both formats for compatibility:
 * - receiver/to: destination address
 * - validAfter: timestamp after which payment is valid
 * - validBefore/extra: timestamp before which payment is valid (our extension)
 */
export interface Permit2Witness {
  receiver: `0x${string}`; // Alias: "to" in x402 spec
  to?: `0x${string}`; // x402 spec field name
  validAfter: number;
  validBefore: number; // Our extension (x402 uses "extra" object)
}

export interface PaymentRequirements {
  scheme: 'exact';
  network: string;
  maxAmountRequired: string;
  resource: string;
  payTo: `0x${string}`;
  token?: `0x${string}`; // Optional: specific token required (Permit2 style)
  asset?: `0x${string}`; // Optional: asset address (ERC-3009/OpenFacilitator style)
}

// ============================================================================
// Facilitator API Types
// ============================================================================

export interface VerifyRequest {
  payload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export interface VerifyResponse {
  isValid: boolean;
  payer?: `0x${string}`;
  /** Standardized x402 error code */
  errorCode?: X402VerifyInvalidReasonType;
  /** Human-readable error description */
  invalidReason?: string;
  token?: {
    address: string;
    symbol: string;
    decimals: number;
    isWhitelisted: boolean;
    discount?: string;
    feeExempt?: boolean;
  };
}

export interface SettleRequest {
  payload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export interface SettleResponse {
  success: boolean;
  transactionHash?: `0x${string}`;
  blockNumber?: string;
  network?: string;
  payer?: `0x${string}`;
  receiver?: `0x${string}`;
  amount?: string;
  token?: string;
  fee?: string;
  feePercent?: number;
  /** Standardized x402 error code */
  errorCode?: X402SettleErrorReasonType;
  /** Human-readable error description */
  error?: string;
  details?: string;
}

export interface SupportedResponse {
  x402Version: number;
  schemes: string[];
  networks: string[];
  tokens: SupportedToken[];
  facilitator: {
    name: string;
    version: string;
    feeModel: string;
    address?: `0x${string}` | null; // Permit2 spender address
    permit2?: `0x${string}`; // Permit2 contract address
  };
}

// ============================================================================
// Token Types
// ============================================================================

export interface SupportedToken {
  address: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
  /** Discount percentage when paying with this token (e.g., 15 = 15% off) */
  discountPercent?: number;
  /** Fee percentage charged by facilitator (e.g., 0.1 = 0.1%) */
  feePercent?: number;
  /** Whether this token is exempt from fees */
  feeExempt?: boolean;
  /** CoinGecko ID for price lookups */
  coingeckoId?: string;
}

export interface TokenBalance {
  token: `0x${string}`;
  balance: bigint;
  decimals: number;
  symbol: string;
}

// ============================================================================
// Settlement Types
// ============================================================================

export interface SettlementParams {
  permit: {
    permitted: {
      token: `0x${string}`;
      amount: bigint;
    };
    nonce: bigint;
    deadline: bigint;
  };
  transferDetails: {
    to: `0x${string}`;
    requestedAmount: bigint;
  };
  owner: `0x${string}`;
  witness: `0x${string}`; // Witness hash
  witnessTypeString: string;
  signature: `0x${string}`;
}

export interface SettlementResult {
  success: boolean;
  transactionHash?: `0x${string}`;
  blockNumber?: bigint;
  gasUsed?: bigint;
  payer?: `0x${string}`;  // x402 spec requires payer in response
  error?: string;
}

// ============================================================================
// Signature Types
// ============================================================================

export interface EIP712Domain {
  name: string;
  chainId: number;
  verifyingContract: `0x${string}`;
}

export interface RecoveredSigner {
  address: `0x${string}`;
  isValid: boolean;
  error?: string;
}

// ============================================================================
// Error Types (x402 Protocol Standard)
// ============================================================================

/**
 * Standardized x402 verification error reasons
 * Based on Coinbase x402 facilitator spec
 */
export const X402VerifyInvalidReason = {
  insufficient_funds: 'insufficient_funds',
  invalid_scheme: 'invalid_scheme',
  invalid_network: 'invalid_network',
  invalid_x402_version: 'invalid_x402_version',
  invalid_payment_requirements: 'invalid_payment_requirements',
  invalid_payload: 'invalid_payload',
  invalid_exact_evm_payload_authorization_value: 'invalid_exact_evm_payload_authorization_value',
  invalid_exact_evm_payload_authorization_value_too_low: 'invalid_exact_evm_payload_authorization_value_too_low',
  invalid_exact_evm_payload_authorization_valid_after: 'invalid_exact_evm_payload_authorization_valid_after',
  invalid_exact_evm_payload_authorization_valid_before: 'invalid_exact_evm_payload_authorization_valid_before',
  invalid_exact_evm_payload_authorization_typed_data_message: 'invalid_exact_evm_payload_authorization_typed_data_message',
  invalid_exact_evm_payload_signature: 'invalid_exact_evm_payload_signature',
  invalid_exact_evm_payload_signature_address: 'invalid_exact_evm_payload_signature_address',
  // Extended codes for our facilitator
  nonce_already_used: 'nonce_already_used',
  permit2_allowance_required: 'permit2_allowance_required',
  token_not_whitelisted: 'token_not_whitelisted',
} as const;

export type X402VerifyInvalidReasonType = typeof X402VerifyInvalidReason[keyof typeof X402VerifyInvalidReason];

/**
 * Standardized x402 settlement error reasons
 * Based on Coinbase x402 facilitator spec
 */
export const X402SettleErrorReason = {
  insufficient_funds: 'insufficient_funds',
  invalid_scheme: 'invalid_scheme',
  invalid_network: 'invalid_network',
  invalid_x402_version: 'invalid_x402_version',
  invalid_payment_requirements: 'invalid_payment_requirements',
  invalid_payload: 'invalid_payload',
  invalid_exact_evm_payload_authorization_value: 'invalid_exact_evm_payload_authorization_value',
  invalid_exact_evm_payload_authorization_valid_after: 'invalid_exact_evm_payload_authorization_valid_after',
  invalid_exact_evm_payload_authorization_valid_before: 'invalid_exact_evm_payload_authorization_valid_before',
  invalid_exact_evm_payload_authorization_typed_data_message: 'invalid_exact_evm_payload_authorization_typed_data_message',
  invalid_exact_evm_payload_signature_address: 'invalid_exact_evm_payload_signature_address',
  // Extended codes for our facilitator
  nonce_already_used: 'nonce_already_used',
  permit2_allowance_required: 'permit2_allowance_required',
  token_not_whitelisted: 'token_not_whitelisted',
  transaction_reverted: 'transaction_reverted',
  transaction_timeout: 'transaction_timeout',
  facilitator_not_configured: 'facilitator_not_configured',
} as const;

export type X402SettleErrorReasonType = typeof X402SettleErrorReason[keyof typeof X402SettleErrorReason];

// Legacy types for backwards compatibility
export type VerificationError =
  | 'invalid_signature'
  | 'insufficient_balance'
  | 'nonce_already_used'
  | 'deadline_expired'
  | 'invalid_receiver'
  | 'unsupported_token'
  | 'unsupported_network'
  | 'amount_mismatch'
  | 'simulation_failed'
  | 'internal_error';

export type SettlementError =
  | VerificationError
  | 'transaction_reverted'
  | 'gas_estimation_failed'
  | 'rpc_error'
  | 'timeout';

// ============================================================================
// Nonce Tracking
// ============================================================================

export interface NonceRecord {
  nonce: string;
  payer: `0x${string}`;
  token: `0x${string}`;
  amount: string;
  settledAt: Date;
  transactionHash: `0x${string}`;
}
