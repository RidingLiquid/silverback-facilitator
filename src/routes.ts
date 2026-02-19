/**
 * x402 Facilitator HTTP Routes
 *
 * Spec-compliant endpoints:
 * - GET  /supported — list supported kinds, extensions, signers
 * - POST /verify    — verify a payment signature
 * - POST /settle    — execute settlement on-chain
 * - GET  /health    — operational status
 */

import { Router, Request, Response } from 'express';
import { getFacilitator, isReady, getAddresses } from './facilitator';

const router = Router();

// ─── GET /supported ──────────────────────────────────────────────────────────
router.get('/supported', (_req: Request, res: Response) => {
  if (!isReady()) {
    return res.status(503).json({ error: 'Facilitator not initialized' });
  }
  res.json(getFacilitator().getSupported());
});

// ─── POST /verify ────────────────────────────────────────────────────────────
router.post('/verify', async (req: Request, res: Response) => {
  if (!isReady()) {
    return res.status(503).json({ error: 'Facilitator not initialized' });
  }

  const { paymentPayload, paymentRequirements } = req.body;
  if (!paymentPayload || !paymentRequirements) {
    return res.status(400).json({
      error: 'Missing required fields: paymentPayload, paymentRequirements',
    });
  }

  try {
    const result = await getFacilitator().verify(paymentPayload, paymentRequirements);
    res.json(result);
  } catch (err) {
    console.error('[verify] Error:', err);
    res.json({
      isValid: false,
      invalidReason: 'verification_error',
      invalidMessage: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

// ─── POST /settle ────────────────────────────────────────────────────────────
router.post('/settle', async (req: Request, res: Response) => {
  if (!isReady()) {
    return res.status(503).json({ error: 'Facilitator not initialized' });
  }

  const { paymentPayload, paymentRequirements } = req.body;
  if (!paymentPayload || !paymentRequirements) {
    return res.status(400).json({
      error: 'Missing required fields: paymentPayload, paymentRequirements',
    });
  }

  try {
    const result = await getFacilitator().settle(paymentPayload, paymentRequirements);
    res.json(result);
  } catch (err) {
    console.error('[settle] Error:', err);
    res.json({
      success: false,
      errorReason: 'settlement_error',
      errorMessage: err instanceof Error ? err.message : 'Unknown error',
      transaction: '',
      network: paymentRequirements?.network || 'unknown',
    });
  }
});

// ─── GET /health ─────────────────────────────────────────────────────────────
router.get('/health', (_req: Request, res: Response) => {
  const addrs = getAddresses();
  const networks: string[] = [];
  if (addrs.evm) networks.push('eip155:8453');
  if (addrs.svm) networks.push('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');

  res.json({
    status: isReady() ? 'ok' : 'unhealthy',
    name: 'Silverback x402 Facilitator',
    version: '2.0.0',
    networks,
    addresses: {
      evm: addrs.evm || null,
      svm: addrs.svm || null,
    },
    timestamp: new Date().toISOString(),
  });
});

export default router;
