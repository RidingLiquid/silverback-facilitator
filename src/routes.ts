/**
 * x402 Facilitator HTTP Routes
 *
 * Spec-compliant endpoints:
 * - GET  /supported            — list supported kinds, extensions, signers
 * - POST /verify               — verify a payment signature
 * - POST /settle               — execute settlement on-chain
 * - GET  /health               — operational status
 * - GET  /discovery/resources  — Bazaar resource catalog
 */

import { Router, Request, Response } from 'express';
import { extractDiscoveryInfo } from '@x402/extensions/bazaar';
import { getFacilitator, isReady, getAddresses } from './facilitator';

const router = Router();

// ─── Bazaar Catalog (in-memory) ──────────────────────────────────────────────

interface CatalogedResource {
  resourceUrl: string;
  method: string;
  description?: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  discoveryInfo?: any;
  firstSeen: string;
  lastSeen: string;
  settleCount: number;
}

// Keyed by resourceUrl
const catalog = new Map<string, CatalogedResource>();

function catalogFromSettle(paymentPayload: any, paymentRequirements: any): void {
  try {
    const discovered = extractDiscoveryInfo(paymentPayload, paymentRequirements);

    // Even without Bazaar extension, catalog the resource URL from the payload
    const url = discovered?.resourceUrl
      || paymentPayload?.resource?.url
      || paymentRequirements?.resource?.url;

    if (!url) return;

    const existing = catalog.get(url);
    const now = new Date().toISOString();

    if (existing) {
      existing.lastSeen = now;
      existing.settleCount++;
      // Update discovery info if we got richer data
      if (discovered?.discoveryInfo && !existing.discoveryInfo) {
        existing.discoveryInfo = discovered.discoveryInfo;
        existing.method = discovered.method;
      }
    } else {
      catalog.set(url, {
        resourceUrl: url,
        method: discovered?.method || 'GET',
        description: paymentPayload?.resource?.description,
        network: paymentRequirements?.network || 'unknown',
        asset: paymentRequirements?.asset || paymentRequirements?.token || '',
        amount: paymentRequirements?.amount || paymentRequirements?.maxAmountRequired || '',
        payTo: paymentRequirements?.payTo || '',
        discoveryInfo: discovered?.discoveryInfo || null,
        firstSeen: now,
        lastSeen: now,
        settleCount: 1,
      });
    }
  } catch {
    // Non-critical — don't let cataloging errors break settlement
  }
}

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

    // Catalog resource on successful settlement
    if (result.success) {
      catalogFromSettle(paymentPayload, paymentRequirements);
    }

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

// ─── GET /discovery/resources ────────────────────────────────────────────────
router.get('/discovery/resources', (_req: Request, res: Response) => {
  const resources = Array.from(catalog.values()).map((r) => ({
    url: r.resourceUrl,
    method: r.method,
    description: r.description || null,
    network: r.network,
    price: r.amount ? { asset: r.asset, amount: r.amount } : null,
    payTo: r.payTo,
    discoveryInfo: r.discoveryInfo || null,
    firstSeen: r.firstSeen,
    lastSeen: r.lastSeen,
    settleCount: r.settleCount,
  }));

  res.json({
    version: '2.0',
    facilitator: 'Silverback x402 Facilitator',
    metadata: {
      name: 'Silverback',
      provider: 'Silverback DeFi',
      website: 'https://silverbackdefi.app',
      description: 'x402 payment facilitator — Base USDC + Solana USDC',
    },
    resourceCount: resources.length,
    resources,
  });
});

// ─── GET /health ─────────────────────────────────────────────────────────────
router.get('/health', (_req: Request, res: Response) => {
  const addrs = getAddresses();
  const networks: string[] = [];
  if (addrs.evm) networks.push('eip155:8453');
  if (addrs.skale) networks.push('eip155:1187947933');
  if (addrs.svm) networks.push('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');

  res.json({
    status: isReady() ? 'ok' : 'unhealthy',
    name: 'Silverback x402 Facilitator',
    version: '2.0.0',
    networks,
    bazaar: { catalogedResources: catalog.size },
    addresses: {
      evm: addrs.evm || null,
      svm: addrs.svm || null,
    },
    timestamp: new Date().toISOString(),
  });
});

export default router;
