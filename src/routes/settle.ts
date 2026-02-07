/**
 * POST /settle
 *
 * Executes a payment on-chain via Permit2.
 * Called by resource servers after granting access to collect payment.
 */

import { Router, Request, Response } from 'express';
import type { SettleRequest, SettleResponse } from '../types';
import { X402SettleErrorReason } from '../types';
import { validatePayloadStructure, validateRequirementsStructure } from '../services/signature';
import { settlePaymentWithFee, getSettlementStats, getRecentSettlements } from '../services/settlement';
import { getTokenByAddress, getTokenFeePercent, formatTokenAmount } from '../config/tokens';
import { isNetworkSupported } from '../config/networks';

const router = Router();

/**
 * POST /settle
 *
 * Executes the payment on-chain.
 * This transfers tokens from payer to receiver via Permit2.
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
        success: false,
        errorReason: X402SettleErrorReason.invalid_payload,
        payer: '',
        transaction: '',
        network: '',
      });
    }

    // 2. Validate payload structure
    if (!validatePayloadStructure(payload)) {
      return res.status(400).json({
        success: false,
        errorReason: X402SettleErrorReason.invalid_payload,
        payer: '',
        transaction: '',
        network: '',
      });
    }

    // 3. Validate requirements structure
    if (!validateRequirementsStructure(paymentRequirements)) {
      return res.status(400).json({
        success: false,
        errorReason: X402SettleErrorReason.invalid_payment_requirements,
        payer: '',
        transaction: '',
        network: '',
      });
    }

    // 3b. Validate network
    if (!isNetworkSupported(payload.network)) {
      return res.status(400).json({
        success: false,
        errorReason: X402SettleErrorReason.invalid_network,
        payer: '',
        transaction: '',
        network: '',
      });
    }

    // 3c. Validate scheme
    if (payload.scheme !== 'exact') {
      return res.status(400).json({
        success: false,
        errorReason: X402SettleErrorReason.invalid_scheme,
        payer: '',
        transaction: '',
        network: '',
      });
    }

    // 3d. Validate x402 version (check both top-level and nested)
    const x402Version = topLevelVersion || payload.x402Version;
    if (x402Version !== 1 && x402Version !== 2) {
      return res.status(400).json({
        success: false,
        errorReason: X402SettleErrorReason.invalid_x402_version,
        payer: '',
        transaction: '',
        network: '',
      });
    }

    console.log(`[Settle] Processing payment for resource: ${paymentRequirements.resource}`);

    // 4. Execute settlement
    const result = await settlePaymentWithFee(payload, paymentRequirements);

    if (!result.success) {
      console.error(`[Settle] Failed: ${result.error}`);
      const errorCode = mapSettleErrorToX402Code(result.error);
      return res.status(200).json({
        success: false,
        errorReason: errorCode,
        payer: result.payer || '',
        transaction: '',
        network: payload.network,
      });
    }

    // 5. Build success response (x402 spec compliant with extra fields)
    const tokenAddress = payload.payload.authorization.permitted.token;
    const tokenInfo = getTokenByAddress(tokenAddress);
    const amount = BigInt(payload.payload.authorization.permitted.amount);

    const response = {
      // x402 spec required fields
      success: true,
      payer: result.payer || '',
      transaction: result.transactionHash || '',  // x402 spec field name
      network: payload.network,
      // Aliases for backward compatibility
      transactionHash: result.transactionHash,    // Our original field name
      // Extra fields (not in x402 spec but useful)
      blockNumber: result.blockNumber?.toString(),
      token: tokenInfo?.symbol || tokenAddress,
      amount: amount.toString(),
      fee: result.fee?.toString(),
      feePercent: getTokenFeePercent(tokenAddress),
    };

    const duration = Date.now() - startTime;
    console.log(
      `[Settle] Success! Hash: ${result.transactionHash}, ` +
      `Amount: ${formatTokenAmount(amount, tokenInfo?.decimals || 18)} ${tokenInfo?.symbol || 'tokens'}, ` +
      `Fee: ${result.fee ? formatTokenAmount(result.fee, tokenInfo?.decimals || 18) : '0'}, ` +
      `Duration: ${duration}ms`
    );

    return res.status(200).json(response);
  } catch (error) {
    console.error('[Settle] Unexpected error:', error);
    return res.status(500).json({
      success: false,
      errorReason: X402SettleErrorReason.invalid_payload,
      payer: '',
      transaction: '',
      network: '',
    });
  }
});

/**
 * Map settlement errors to X402 standard error codes
 */
function mapSettleErrorToX402Code(error?: string): typeof X402SettleErrorReason[keyof typeof X402SettleErrorReason] {
  if (!error) return X402SettleErrorReason.invalid_payload;

  const errorLower = error.toLowerCase();

  if (errorLower.includes('insufficient') || errorLower.includes('balance')) {
    return X402SettleErrorReason.insufficient_funds;
  }
  if (errorLower.includes('nonce')) {
    return X402SettleErrorReason.nonce_already_used;
  }
  if (errorLower.includes('permit2') || errorLower.includes('allowance') || errorLower.includes('approval')) {
    return X402SettleErrorReason.permit2_allowance_required;
  }
  if (errorLower.includes('revert') || errorLower.includes('failed')) {
    return X402SettleErrorReason.transaction_reverted;
  }
  if (errorLower.includes('timeout')) {
    return X402SettleErrorReason.transaction_timeout;
  }
  if (errorLower.includes('signature')) {
    return X402SettleErrorReason.invalid_exact_evm_payload_signature_address;
  }
  if (errorLower.includes('deadline') || errorLower.includes('expired')) {
    return X402SettleErrorReason.invalid_exact_evm_payload_authorization_valid_before;
  }
  if (errorLower.includes('not configured') || errorLower.includes('facilitator')) {
    return X402SettleErrorReason.facilitator_not_configured;
  }
  if (errorLower.includes('network')) {
    return X402SettleErrorReason.invalid_network;
  }

  return X402SettleErrorReason.invalid_payload;
}

/**
 * GET /settle/stats
 *
 * Returns settlement statistics (admin endpoint).
 */
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const stats = await getSettlementStats();
    res.json(stats);
  } catch (error) {
    console.error('[Settle/Stats] Error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

/**
 * GET /settle/recent
 *
 * Returns recent settlements (admin endpoint).
 */
router.get('/recent', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const settlements = await getRecentSettlements(limit);

    // Sanitize for response (don't expose full addresses)
    const sanitized = settlements.map((s) => ({
      ...s,
      payer: typeof s.payer === 'string' ? `${s.payer.slice(0, 6)}...${s.payer.slice(-4)}` : s.payer,
      receiver: typeof s.receiver === 'string' ? `${s.receiver.slice(0, 6)}...${s.receiver.slice(-4)}` : s.receiver,
    }));

    res.json({ settlements: sanitized });
  } catch (error) {
    console.error('[Settle/Recent] Error:', error);
    res.status(500).json({ error: 'Failed to get recent settlements' });
  }
});

export default router;
