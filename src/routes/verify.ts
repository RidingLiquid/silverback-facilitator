/**
 * POST /verify
 *
 * Verifies a payment signature without settling it.
 * Called by resource servers to validate payments before granting access.
 */

import { Router, Request, Response } from 'express';
import type { VerifyRequest, VerifyResponse } from '../types';
import { X402VerifyInvalidReason } from '../types';
import { verifySignature, validatePayloadStructure, validateRequirementsStructure } from '../services/signature';
import { checkPayerReadiness } from '../services/balance';
import { isNonceUsed } from '../services/settlement';
import { extractErc3009Payload, verifyErc3009Payment } from '../services/erc3009';
import { getTokenByAddress, getTokenDiscount, isTokenWhitelisted } from '../config/tokens';
import { isNetworkSupported, parseCaip2 } from '../config/networks';

const router = Router();

/**
 * POST /verify
 *
 * Validates a payment payload against requirements.
 * Does NOT execute the payment - just checks if it would succeed.
 */
router.post('/', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    const body = req.body;

    // x402 spec compatibility: accept both 'payload' and 'paymentPayload'
    const payload = body.payload || body.paymentPayload;
    const paymentRequirements = body.paymentRequirements;

    // x402 spec: check for top-level x402Version (in addition to nested)
    const topLevelVersion = body.x402Version;

    // Normalize v2 payloads: SDK v2 ExactEvmScheme doesn't include scheme/network
    // at the top level of the payment payload, only in paymentRequirements
    if (payload && paymentRequirements) {
      if (!payload.scheme && paymentRequirements.scheme) payload.scheme = paymentRequirements.scheme;
      if (!payload.network && paymentRequirements.network) payload.network = paymentRequirements.network;
      if (!payload.x402Version && topLevelVersion) payload.x402Version = topLevelVersion;
    }

    // 1. Validate request structure
    if (!payload || !paymentRequirements) {
      return res.status(400).json({
        isValid: false,
        invalidReason: 'Missing payload/paymentPayload or paymentRequirements',
        payer: '',
      });
    }

    // Reconstruct body with normalized field names
    const normalizedBody: VerifyRequest = { payload, paymentRequirements };

    // 2. Validate payload structure
    if (!validatePayloadStructure(payload)) {
      return res.status(400).json({
        isValid: false,
        invalidReason: 'Invalid payload structure',
        payer: '',
      });
    }

    // 3. Validate requirements structure
    if (!validateRequirementsStructure(paymentRequirements)) {
      return res.status(400).json({
        isValid: false,
        invalidReason: 'Invalid paymentRequirements structure',
        payer: '',
      });
    }

    // 3b. Validate network is supported
    if (!isNetworkSupported(payload.network)) {
      return res.status(400).json({
        isValid: false,
        invalidReason: `Unsupported network: ${payload.network}`,
        payer: '',
      });
    }

    // 3c. Validate scheme
    if (payload.scheme !== 'exact') {
      return res.status(400).json({
        isValid: false,
        invalidReason: `Unsupported scheme: ${payload.scheme}`,
        payer: '',
      });
    }

    // 3d. Validate x402 version (check both top-level and nested)
    const x402Version = topLevelVersion || payload.x402Version;
    if (x402Version !== 1 && x402Version !== 2) {
      return res.status(400).json({
        isValid: false,
        invalidReason: `Unsupported x402 version: ${x402Version}`,
        payer: '',
      });
    }

    // 4. Detect payload format and verify accordingly
    const erc3009Payload = extractErc3009Payload(normalizedBody.payload);

    if (erc3009Payload) {
      // ---- ERC-3009 verification path ----
      const tokenAddress = (paymentRequirements.asset || paymentRequirements.token) as `0x${string}`;
      if (!tokenAddress) {
        return res.status(400).json({
          isValid: false,
          invalidReason: 'Missing token/asset in paymentRequirements for ERC-3009 payment',
          payer: '',
        });
      }

      const parsedNetwork = parseCaip2(payload.network);
      const chainId = parsedNetwork?.chainId || 8453;

      console.log(`[Verify] ERC-3009 payload detected, token: ${tokenAddress}, from: ${erc3009Payload.authorization.from}`);

      const verifyResult = await verifyErc3009Payment(
        erc3009Payload,
        tokenAddress,
        paymentRequirements,
        chainId,
        payload.network
      );

      if (!verifyResult.isValid) {
        return res.status(200).json({
          isValid: false,
          invalidReason: `${verifyResult.error}: ${verifyResult.details}`,
          payer: verifyResult.payer || '',
        });
      }

      const payer = verifyResult.payer!;
      const amount = BigInt(erc3009Payload.authorization.value);

      // Check nonce (ERC-3009 nonces are bytes32)
      const nonceUsed = await isNonceUsed(payer, erc3009Payload.authorization.nonce);
      if (nonceUsed) {
        return res.status(200).json({
          isValid: false,
          invalidReason: 'Nonce already used (replay attack prevented)',
          payer,
        });
      }

      // For ERC-3009, only check balance (no Permit2 approval needed)
      const readiness = await checkPayerReadiness(payer, tokenAddress, amount, payload.network);
      if (!readiness.hasBalance) {
        return res.status(200).json({
          isValid: false,
          invalidReason: `Insufficient balance: has ${readiness.balance}, needs ${readiness.required}`,
          payer,
        });
      }

      const tokenInfo = getTokenByAddress(tokenAddress);
      const discount = getTokenDiscount(tokenAddress);

      console.log(`[Verify] Valid ERC-3009 payment from ${payer}: ${amount} ${tokenInfo?.symbol || 'tokens'} (${Date.now() - startTime}ms)`);

      return res.status(200).json({
        isValid: true,
        payer,
        token: {
          address: tokenAddress,
          symbol: tokenInfo?.symbol || readiness.token.symbol,
          decimals: tokenInfo?.decimals || readiness.token.decimals,
          isWhitelisted: isTokenWhitelisted(tokenAddress),
          discount: discount > 0 ? `${discount}%` : undefined,
          feeExempt: tokenInfo?.feeExempt,
        },
      });
    }

    // ---- Permit2 verification path (original) ----
    const verifyResult = await verifySignature(normalizedBody.payload, normalizedBody.paymentRequirements);

    if (!verifyResult.isValid) {
      const errorCode = mapSignatureErrorToX402Code(verifyResult.error);
      return res.status(200).json({
        isValid: false,
        invalidReason: `${verifyResult.error}: ${verifyResult.details}`,
        payer: verifyResult.payer || '',
      });
    }

    const payer = verifyResult.payer!;
    const tokenAddress = normalizedBody.payload.payload.authorization.permitted.token;
    const amount = BigInt(normalizedBody.payload.payload.authorization.permitted.amount);

    // 5. Check if nonce already used
    const nonceUsed = await isNonceUsed(payer, normalizedBody.payload.payload.authorization.nonce);
    if (nonceUsed) {
      return res.status(200).json({
        isValid: false,
        invalidReason: 'Nonce already used (replay attack prevented)',
        payer,
      });
    }

    // 6. Check payer readiness (balance + approval)
    const readiness = await checkPayerReadiness(
      payer,
      tokenAddress as `0x${string}`,
      amount,
      normalizedBody.payload.network
    );

    // x402 Spec: Return 412 Precondition Failed for Permit2 approval issues
    if (!readiness.hasPermit2Approval) {
      return res.status(412).json({
        isValid: false,
        invalidReason: `Permit2 approval required: user must approve ${readiness.required} ${readiness.token.symbol} to Permit2 contract`,
        payer,
        permitInfo: {
          permit2Address: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
          tokenAddress: readiness.token.address,
          requiredAmount: readiness.required.toString(),
        },
      });
    }

    // Check balance separately
    if (!readiness.hasBalance) {
      return res.status(200).json({
        isValid: false,
        invalidReason: `Insufficient balance: has ${readiness.balance}, needs ${readiness.required}`,
        payer,
      });
    }

    // Other issues
    if (readiness.issues.length > 0) {
      return res.status(200).json({
        isValid: false,
        invalidReason: readiness.issues.join('; '),
        payer,
      });
    }

    // 7. Get token info for response
    const tokenInfo = getTokenByAddress(tokenAddress);
    const discount = getTokenDiscount(tokenAddress);
    const isWhitelisted = isTokenWhitelisted(tokenAddress);

    // 8. Build success response (x402 spec compliant with extra fields)
    const response = {
      isValid: true,
      payer,
      token: {
        address: tokenAddress,
        symbol: tokenInfo?.symbol || readiness.token.symbol,
        decimals: tokenInfo?.decimals || readiness.token.decimals,
        isWhitelisted,
        discount: discount > 0 ? `${discount}%` : undefined,
        feeExempt: tokenInfo?.feeExempt,
      },
    };

    console.log(`[Verify] Valid payment from ${payer}: ${amount} ${response.token?.symbol} (${Date.now() - startTime}ms)`);

    return res.status(200).json(response);
  } catch (error) {
    console.error('[Verify] Unexpected error:', error);
    return res.status(500).json({
      isValid: false,
      invalidReason: 'Internal server error',
      payer: '',
    });
  }
});

/**
 * Map internal signature verification errors to X402 standard error codes
 */
function mapSignatureErrorToX402Code(error?: string): typeof X402VerifyInvalidReason[keyof typeof X402VerifyInvalidReason] {
  if (!error) return X402VerifyInvalidReason.invalid_payload;

  const errorLower = error.toLowerCase();

  if (errorLower.includes('signature')) {
    return X402VerifyInvalidReason.invalid_exact_evm_payload_signature;
  }
  if (errorLower.includes('deadline') || errorLower.includes('expired')) {
    return X402VerifyInvalidReason.invalid_exact_evm_payload_authorization_valid_before;
  }
  if (errorLower.includes('valid_after') || errorLower.includes('not yet valid')) {
    return X402VerifyInvalidReason.invalid_exact_evm_payload_authorization_valid_after;
  }
  if (errorLower.includes('amount') || errorLower.includes('value')) {
    return X402VerifyInvalidReason.invalid_exact_evm_payload_authorization_value;
  }
  if (errorLower.includes('receiver') || errorLower.includes('address')) {
    return X402VerifyInvalidReason.invalid_exact_evm_payload_signature_address;
  }
  if (errorLower.includes('network')) {
    return X402VerifyInvalidReason.invalid_network;
  }
  if (errorLower.includes('scheme')) {
    return X402VerifyInvalidReason.invalid_scheme;
  }

  return X402VerifyInvalidReason.invalid_payload;
}

/**
 * POST /verify/quick
 *
 * Quick validation - only checks signature, not balance/approval.
 * Useful for pre-flight checks before user commits.
 */
router.post('/quick', async (req: Request, res: Response) => {
  try {
    const body = req.body;

    // x402 spec compatibility: accept both 'payload' and 'paymentPayload'
    const payload = body.payload || body.paymentPayload;
    const paymentRequirements = body.paymentRequirements;

    // Normalize v2 payloads
    if (payload && paymentRequirements) {
      if (!payload.scheme && paymentRequirements.scheme) payload.scheme = paymentRequirements.scheme;
      if (!payload.network && paymentRequirements.network) payload.network = paymentRequirements.network;
      if (!payload.x402Version && body.x402Version) payload.x402Version = body.x402Version;
    }

    if (!payload || !paymentRequirements) {
      return res.status(400).json({
        isValid: false,
        invalidReason: 'Missing payload/paymentPayload or paymentRequirements',
        payer: '',
      });
    }

    if (!validatePayloadStructure(payload)) {
      return res.status(400).json({
        isValid: false,
        invalidReason: 'Invalid payload structure',
        payer: '',
      });
    }

    if (!validateRequirementsStructure(paymentRequirements)) {
      return res.status(400).json({
        isValid: false,
        invalidReason: 'Invalid paymentRequirements structure',
        payer: '',
      });
    }

    // Check for ERC-3009 format
    const erc3009Payload = extractErc3009Payload(payload);
    if (erc3009Payload) {
      const tokenAddress = (paymentRequirements.asset || paymentRequirements.token) as string;
      const parsedNetwork = parseCaip2(payload.network);
      const chainId = parsedNetwork?.chainId || 8453;

      const verifyResult = await verifyErc3009Payment(
        erc3009Payload,
        tokenAddress,
        paymentRequirements,
        chainId,
        payload.network
      );

      return res.status(200).json({
        isValid: verifyResult.isValid,
        invalidReason: verifyResult.isValid ? undefined : `${verifyResult.error}: ${verifyResult.details}`,
        payer: verifyResult.payer || '',
      });
    }

    // Permit2 path
    const verifyResult = await verifySignature(payload, paymentRequirements);

    return res.status(200).json({
      isValid: verifyResult.isValid,
      invalidReason: verifyResult.isValid ? undefined : `${verifyResult.error}: ${verifyResult.details}`,
      payer: verifyResult.payer || '',
    });
  } catch (error) {
    console.error('[Verify/Quick] Error:', error);
    return res.status(500).json({
      isValid: false,
      invalidReason: 'Internal server error',
      payer: '',
    });
  }
});

export default router;
