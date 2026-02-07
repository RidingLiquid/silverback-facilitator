/**
 * Signature Verification Service
 *
 * Validates x402 payment signatures using EIP-712 typed data recovery.
 */

import { privateKeyToAccount } from 'viem/accounts';
import type {
  PaymentPayload,
  PaymentRequirements,
  VerificationError,
} from '../types';
import {
  recoverPermit2Signer,
  isDeadlineExpired,
  isWithinValidityWindow,
} from '../utils/permit2';
import {
  getNetworkConfig,
  parseCaip2,
  FACILITATOR_CONFIG,
  X402_PROXY_MODE,
  X402_PERMIT2_PROXY_ADDRESS,
  PERMIT2_ADDRESS,
} from '../config/networks';
import { isTokenWhitelisted } from '../config/tokens';
import { validateAmount, redactAddress } from '../utils/security';

// ============================================================================
// Signature Verification
// ============================================================================

export interface SignatureVerificationResult {
  isValid: boolean;
  payer?: `0x${string}`;
  error?: VerificationError;
  details?: string;
}

/**
 * Verify a payment signature
 *
 * Checks:
 * 1. Network is supported
 * 2. Token is supported (or ALLOW_ANY_ERC20)
 * 3. Signature is valid and recovers to a valid address
 * 4. Deadline has not expired
 * 5. Validity window is correct
 * 6. Receiver matches payTo
 * 7. Amount meets requirements
 */
export async function verifySignature(
  payload: PaymentPayload,
  requirements: PaymentRequirements
): Promise<SignatureVerificationResult> {
  try {
    // 1. Validate network
    const networkConfig = getNetworkConfig(payload.network);
    if (!networkConfig) {
      return {
        isValid: false,
        error: 'unsupported_network',
        details: `Network ${payload.network} is not supported`,
      };
    }

    // 2. Validate token is in curated whitelist
    const tokenAddress = payload.payload.authorization.permitted.token;
    if (!isTokenWhitelisted(tokenAddress)) {
      return {
        isValid: false,
        error: 'unsupported_token',
        details: `Token ${tokenAddress} is not whitelisted. Contact Silverback to request listing.`,
      };
    }

    // 2b. Validate spender address
    // In proxy mode: spender must be x402Permit2Proxy
    // In direct mode: spender must be either Permit2 or the proxy address (for security)
    const spender = payload.payload.authorization.spender;
    if (X402_PROXY_MODE === 'proxy') {
      if (spender.toLowerCase() !== X402_PERMIT2_PROXY_ADDRESS.toLowerCase()) {
        return {
          isValid: false,
          error: 'invalid_signature',
          details: `Spender must be x402Permit2Proxy (${redactAddress(X402_PERMIT2_PROXY_ADDRESS)}), got ${redactAddress(spender)}`,
        };
      }
    } else {
      // Direct mode: validate spender is a known/safe address
      const validSpenders = [
        PERMIT2_ADDRESS.toLowerCase(),
        X402_PERMIT2_PROXY_ADDRESS.toLowerCase(),
      ].filter(addr => addr !== '0x0000000000000000000000000000000000000000');

      // Also allow facilitator's own address as spender
      const facilitatorKey = process.env.FACILITATOR_PRIVATE_KEY;
      if (facilitatorKey) {
        try {
          const account = privateKeyToAccount(facilitatorKey as `0x${string}`);
          validSpenders.push(account.address.toLowerCase());
        } catch {
          // Ignore if key is invalid
        }
      }

      if (!validSpenders.includes(spender.toLowerCase())) {
        return {
          isValid: false,
          error: 'invalid_signature',
          details: `Invalid spender address: ${redactAddress(spender)}. Must be Permit2 or facilitator.`,
        };
      }
    }

    // 3. Recover signer from signature
    const parsedNetwork = parseCaip2(payload.network);
    if (!parsedNetwork) {
      return {
        isValid: false,
        error: 'unsupported_network',
        details: `Invalid CAIP-2 identifier: ${payload.network}`,
      };
    }

    const signerResult = await recoverPermit2Signer(
      payload.payload,
      parsedNetwork.chainId
    );

    if (!signerResult.isValid) {
      return {
        isValid: false,
        error: 'invalid_signature',
        details: signerResult.error || 'Failed to recover signer',
      };
    }

    // 4. Check deadline
    if (isDeadlineExpired(payload.payload.authorization.deadline)) {
      return {
        isValid: false,
        payer: signerResult.address,
        error: 'deadline_expired',
        details: `Deadline ${payload.payload.authorization.deadline} has passed`,
      };
    }

    // 5. Check validity window
    const { validAfter, validBefore } = payload.payload.witness;
    if (!isWithinValidityWindow(validAfter, validBefore)) {
      return {
        isValid: false,
        payer: signerResult.address,
        error: 'deadline_expired',
        details: `Not within validity window: ${validAfter} - ${validBefore}`,
      };
    }

    // 6. Validate receiver matches payTo
    // Support both "receiver" (our format) and "to" (x402 spec format)
    const receiver = payload.payload.witness.receiver || payload.payload.witness.to;
    if (!receiver) {
      return {
        isValid: false,
        payer: signerResult.address,
        error: 'invalid_receiver',
        details: 'Missing receiver/to address in witness',
      };
    }

    if (receiver.toLowerCase() !== requirements.payTo.toLowerCase()) {
      return {
        isValid: false,
        payer: signerResult.address,
        error: 'invalid_receiver',
        details: `Receiver ${receiver} does not match payTo ${requirements.payTo}`,
      };
    }

    // 7. Validate amount with bounds checking
    const payloadAmountValidation = validateAmount(payload.payload.authorization.permitted.amount);
    if (!payloadAmountValidation.valid) {
      return {
        isValid: false,
        payer: signerResult.address,
        error: 'amount_mismatch',
        details: `Invalid payload amount: ${payloadAmountValidation.error}`,
      };
    }
    const payloadAmount = payloadAmountValidation.amount!;

    const requiredAmountValidation = validateAmount(requirements.maxAmountRequired);
    if (!requiredAmountValidation.valid) {
      return {
        isValid: false,
        payer: signerResult.address,
        error: 'amount_mismatch',
        details: `Invalid required amount: ${requiredAmountValidation.error}`,
      };
    }
    const requiredAmount = requiredAmountValidation.amount!;

    if (payloadAmount < requiredAmount) {
      return {
        isValid: false,
        payer: signerResult.address,
        error: 'amount_mismatch',
        details: `Amount ${payloadAmount} is less than required ${requiredAmount}`,
      };
    }

    // 8. Validate token matches requirement (if specified)
    if (
      requirements.token &&
      tokenAddress.toLowerCase() !== requirements.token.toLowerCase()
    ) {
      return {
        isValid: false,
        payer: signerResult.address,
        error: 'unsupported_token',
        details: `Token ${tokenAddress} does not match required ${requirements.token}`,
      };
    }

    // All checks passed
    return {
      isValid: true,
      payer: signerResult.address,
    };
  } catch (error) {
    return {
      isValid: false,
      error: 'internal_error',
      details: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Validate payload structure
 */
export function validatePayloadStructure(payload: unknown): payload is PaymentPayload {
  if (!payload || typeof payload !== 'object') return false;

  const p = payload as Record<string, unknown>;

  if (p.x402Version !== 1 && p.x402Version !== 2) return false;
  if (p.scheme !== 'exact') return false;
  if (typeof p.network !== 'string') return false;
  if (!p.payload || typeof p.payload !== 'object') return false;

  const inner = p.payload as Record<string, unknown>;

  if (typeof inner.signature !== 'string') return false;
  if (!inner.authorization || typeof inner.authorization !== 'object') return false;
  if (!inner.witness || typeof inner.witness !== 'object') return false;

  return true;
}

/**
 * Validate requirements structure
 */
export function validateRequirementsStructure(
  requirements: unknown
): requirements is PaymentRequirements {
  if (!requirements || typeof requirements !== 'object') return false;

  const r = requirements as Record<string, unknown>;

  if (r.scheme !== 'exact') return false;
  if (typeof r.network !== 'string') return false;
  if (typeof r.maxAmountRequired !== 'string') return false;
  if (typeof r.resource !== 'string') return false;
  if (typeof r.payTo !== 'string') return false;

  return true;
}
