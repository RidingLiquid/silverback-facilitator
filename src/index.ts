/**
 * Silverback x402 Multi-Token Facilitator
 *
 * A Permit2 + ERC-3009 payment facilitator that supports any ERC-20 token.
 * Special pricing for $BACK token (fee-exempt, 15% discount).
 *
 * Compliant with x402 Protocol Specification:
 * - https://github.com/coinbase/x402
 * - https://docs.cdp.coinbase.com/x402/welcome
 *
 * Supported Protocols:
 * - Permit2: Works with ANY ERC-20 token
 * - ERC-3009: Native support for USDC (transferWithAuthorization)
 *
 * Features:
 * - PostgreSQL persistence (optional, falls back to in-memory)
 * - Webhook notifications for settlements
 * - Multi-protocol support (auto-detection)
 *
 * Endpoints:
 * - GET  /supported           - List supported networks, tokens, schemes
 * - GET  /supported/tokens    - List supported tokens with details
 * - GET  /supported/networks  - List supported networks
 * - POST /verify              - Verify a payment signature
 * - POST /verify/quick        - Quick signature check (no balance check)
 * - POST /settle              - Execute payment on-chain
 * - GET  /settle/stats        - Settlement statistics
 * - GET  /settle/recent       - Recent settlements
 * - POST /webhooks            - Register a webhook
 * - GET  /webhooks            - List webhooks
 * - DELETE /webhooks/:id      - Deactivate a webhook
 * - GET  /health              - Health check
 */

import express, { Express, Router, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { privateKeyToAccount } from 'viem/accounts';
import supportedRouter from './routes/supported';
import verifyRouter from './routes/verify';
import settleRouter from './routes/settle';
import webhooksRouter from './routes/webhooks';
import discoveryRouter from './routes/discovery';
import { FACILITATOR_CONFIG, getSupportedNetworks, X402_PROXY_MODE, FEE_SPLITTER_CONFIG } from './config/networks';
import { getSupportedTokensList } from './config/tokens';
import { initDatabase, isUsingPostgres } from './services/database';
import { initPriceCache, getCacheStatus } from './services/price-cache';
import { validatePrivateKey, validatePositiveInt, redactAddress } from './utils/security';

// ============================================================================
// Simple Rate Limiting (in-memory, use Redis in production)
// ============================================================================

const requestCounts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100; // 100 requests per minute per IP

function getRateLimitKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const record = requestCounts.get(key);

  if (!record || record.resetAt < now) {
    requestCounts.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  record.count++;
  return record.count > RATE_LIMIT_MAX_REQUESTS;
}

// Cleanup old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of requestCounts.entries()) {
    if (record.resetAt < now) {
      requestCounts.delete(key);
    }
  }
}, 60000);

// ============================================================================
// Create Facilitator Router (for mounting on existing server)
// ============================================================================

/**
 * Create a router that can be mounted on an existing Express app
 *
 * Usage:
 *   import { createFacilitatorRouter } from './x402-facilitator';
 *   app.use('/facilitator', createFacilitatorRouter());
 */
export function createFacilitatorRouter(): Router {
  const router = Router();

  // Initialize price cache on router creation (fire and forget)
  initPriceCache().catch((err) => {
    console.error('[x402] Failed to initialize price cache:', err);
  });

  // Rate limiting
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/health') {
      return next();
    }

    const key = getRateLimitKey(req);
    if (isRateLimited(key)) {
      return res.status(429).json({
        error: 'Too many requests',
        message: 'Rate limit exceeded. Please try again later.',
      });
    }
    next();
  });

  // Request logging
  router.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.path !== '/health') {
      console.log(`[x402] ${req.method} ${req.baseUrl}${req.path}`);
    }
    next();
  });

  // Health check
  router.get('/health', (_req: Request, res: Response) => {
    const privateKey = process.env.FACILITATOR_PRIVATE_KEY;
    const keyValidation = validatePrivateKey(privateKey);
    const usingDatabase = isUsingPostgres();
    const isProduction = process.env.NODE_ENV === 'production';

    // Determine overall status
    let status: 'ok' | 'degraded' | 'unhealthy' = 'ok';
    const warnings: string[] = [];

    if (!keyValidation.valid) {
      status = 'unhealthy';
      warnings.push('Private key not configured - settlements will fail');
    }

    if (!usingDatabase && isProduction) {
      status = status === 'unhealthy' ? 'unhealthy' : 'degraded';
      warnings.push('No database in production - replay protection limited');
    }

    res.json({
      status,
      name: FACILITATOR_CONFIG.name,
      version: FACILITATOR_CONFIG.version,
      feeModel: FACILITATOR_CONFIG.feeModel,
      proxyMode: X402_PROXY_MODE,
      protocols: ['permit2', 'erc3009'],
      networks: getSupportedNetworks().length,
      tokens: getSupportedTokensList().length,
      configured: keyValidation.valid,
      database: usingDatabase ? 'postgresql' : 'in-memory',
      production: isProduction,
      x402Compliant: true,
      feeSplitter: {
        enabled: FEE_SPLITTER_CONFIG.enabled,
        mainnet: FEE_SPLITTER_CONFIG.addressMainnet,
        testnet: FEE_SPLITTER_CONFIG.addressTestnet,
        defaultTreasury: FEE_SPLITTER_CONFIG.defaultTreasury,
      },
      warnings: warnings.length > 0 ? warnings : undefined,
      timestamp: new Date().toISOString(),
    });
  });

  // Root info
  router.get('/', (_req: Request, res: Response) => {
    res.json({
      name: FACILITATOR_CONFIG.name,
      version: FACILITATOR_CONFIG.version,
      description: FACILITATOR_CONFIG.description,
      logo: FACILITATOR_CONFIG.logo,
      website: FACILITATOR_CONFIG.website,
      docs: FACILITATOR_CONFIG.docs,
      endpoints: {
        '/health': 'Health check',
        '/supported': 'List supported configurations',
        '/supported/tokens': 'List supported tokens with USD prices',
        '/supported/networks': 'List supported networks',
        '/supported/convert': 'Convert USD to token amount (GET ?usd=0.02&token=BACK)',
        '/supported/prices': 'Get all token prices',
        '/supported/prices/refresh': 'Force refresh prices (POST)',
        '/supported/calculate-pricing': 'Calculate fees for a payment',
        '/verify': 'Verify payment signature (POST)',
        '/verify/quick': 'Quick signature check (POST)',
        '/settle': 'Execute payment on-chain (POST)',
        '/settle/stats': 'Settlement statistics',
        '/settle/recent': 'Recent settlements',
        '/webhooks': 'Manage webhooks (GET/POST/DELETE)',
        '/discovery/resources': 'Bazaar discovery - list x402 resources',
        '/discovery/resources/:id': 'Get specific resource by ID',
        '/discovery/categories': 'List resource categories',
        '/discovery/tags': 'List resource tags',
        '/discovery/info': 'Discovery service info',
      },
      protocols: {
        permit2: 'Works with ANY ERC-20 token',
        erc3009: 'Native support for USDC (transferWithAuthorization)',
      },
      features: [
        'Permit2-based (works with ANY ERC-20)',
        'ERC-3009 for USDC compatibility',
        '$BACK token fee-exempt with 15% discount',
        'Whitelisted stablecoins at 0.1% fee',
        'Any ERC-20 at 0.25% fee',
        'Base Mainnet support',
        'Webhook notifications',
        'PostgreSQL persistence (optional)',
      ],
      x402Version: 1,
      schemes: ['exact'],
    });
  });

  // Mount routers
  router.use('/supported', supportedRouter);
  router.use('/verify', verifyRouter);
  router.use('/settle', settleRouter);
  router.use('/webhooks', webhooksRouter);
  router.use('/discovery', discoveryRouter);

  return router;
}

// ============================================================================
// Standalone App
// ============================================================================

const app: Express = express();

// Middleware
app.use(cors());
app.use(express.json());

// Mount facilitator at root when running standalone
app.use('/', createFacilitatorRouter());

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not found',
    message: 'The requested endpoint does not exist',
  });
});

// Error handler - sanitize errors for external responses
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // Log full error internally
  console.error('[x402] Error:', err);

  // Never expose internal error details in production
  const isProduction = process.env.NODE_ENV === 'production';

  res.status(500).json({
    error: 'Internal server error',
    // Only show error message in development, and sanitize it
    message: !isProduction ? err.message?.replace(/0x[a-fA-F0-9]{40,}/g, '[REDACTED]') : undefined,
  });
});

// ============================================================================
// Server Startup
// ============================================================================

const PORT = parseInt(process.env.X402_FACILITATOR_PORT || '3402', 10);

export async function startFacilitator(): Promise<Express> {
  const isProduction = process.env.NODE_ENV === 'production';

  console.log('');
  console.log('='.repeat(60));
  console.log(`  ${FACILITATOR_CONFIG.name} Facilitator - Startup Validation`);
  console.log('='.repeat(60));

  // ============================================================================
  // CRITICAL: Validate Required Configuration
  // ============================================================================

  // 1. Validate FACILITATOR_PRIVATE_KEY
  const privateKey = process.env.FACILITATOR_PRIVATE_KEY;
  const keyValidation = validatePrivateKey(privateKey);
  if (!keyValidation.valid) {
    console.error(`[x402] CRITICAL: ${keyValidation.error}`);
    if (isProduction) {
      throw new Error(`FACILITATOR_PRIVATE_KEY validation failed: ${keyValidation.error}`);
    }
    console.warn('[x402] WARNING: Running without valid private key - settlements will fail');
  } else {
    // Derive and display facilitator address (redacted for security)
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    console.log(`[x402] Facilitator address: ${redactAddress(account.address)}`);
  }

  // 2. Validate DATABASE_URL for production
  const databaseUrl = process.env.DATABASE_URL || process.env.FACILITATOR_DATABASE_URL;
  if (!databaseUrl) {
    if (isProduction) {
      console.error('[x402] CRITICAL: DATABASE_URL not set in production');
      console.error('[x402] Nonce replay protection and audit logs require PostgreSQL');
      throw new Error('DATABASE_URL is required in production for security');
    }
    console.warn('[x402] WARNING: No DATABASE_URL - using in-memory storage (NOT safe for production)');
  }

  // 3. Validate numeric configuration values
  const maxGasValidation = validatePositiveInt(FACILITATOR_CONFIG.maxGasPriceGwei, 'maxGasPriceGwei', 1, 10000);
  if (!maxGasValidation.valid) {
    console.error(`[x402] CRITICAL: ${maxGasValidation.error}`);
    throw new Error(`Configuration error: ${maxGasValidation.error}`);
  }

  const timeoutValidation = validatePositiveInt(FACILITATOR_CONFIG.settlementTimeoutMs, 'settlementTimeoutMs', 5000, 300000);
  if (!timeoutValidation.valid) {
    console.error(`[x402] CRITICAL: ${timeoutValidation.error}`);
    throw new Error(`Configuration error: ${timeoutValidation.error}`);
  }

  const minSettlementValidation = validatePositiveInt(
    Math.round(FACILITATOR_CONFIG.minSettlementUsd * 1000),
    'minSettlementUsd',
    0,
    1000000
  );
  if (FACILITATOR_CONFIG.minSettlementUsd < 0) {
    console.error('[x402] CRITICAL: minSettlementUsd cannot be negative');
    throw new Error('Configuration error: minSettlementUsd cannot be negative');
  }

  console.log('[x402] Configuration validation passed');

  // ============================================================================
  // Initialize Services
  // ============================================================================

  // Initialize database
  const dbInitialized = await initDatabase();
  if (!dbInitialized && isProduction) {
    throw new Error('Failed to connect to database in production mode');
  }

  // Initialize price cache (DexScreener)
  await initPriceCache();

  const priceStatus = getCacheStatus();

  app.listen(PORT, () => {
    console.log('');
    console.log('='.repeat(60));
    console.log(`  ${FACILITATOR_CONFIG.name} v${FACILITATOR_CONFIG.version}`);
    console.log('='.repeat(60));
    console.log(`  Port:       ${PORT}`);
    console.log(`  Mode:       ${isProduction ? 'PRODUCTION' : 'Development'}`);
    console.log(`  Networks:   ${getSupportedNetworks().join(', ')}`);
    console.log(`  Tokens:     ${getSupportedTokensList().map((t) => t.symbol).join(', ')}`);
    console.log(`  Protocols:  Permit2, ERC-3009`);
    console.log(`  Fee:        ${FACILITATOR_CONFIG.feeModel}`);
    console.log(`  Database:   ${isUsingPostgres() ? 'PostgreSQL' : 'In-Memory (dev only)'}`);
    console.log(`  PriceCache: ${priceStatus.tokenCount} tokens (DexScreener, 5min refresh)`);
    console.log('='.repeat(60));
    console.log('');
    console.log('Endpoints:');
    console.log('  GET  /              - API info');
    console.log('  GET  /health        - Health check');
    console.log('  GET  /supported     - Supported configs');
    console.log('  GET  /supported/convert - USD to token conversion');
    console.log('  GET  /supported/prices  - Token prices');
    console.log('  POST /verify        - Verify payment');
    console.log('  POST /settle        - Execute payment');
    console.log('  POST /webhooks      - Register webhook');
    console.log('  GET  /discovery/resources - Bazaar discovery');
    console.log('');
  });

  return app;
}

// Export for testing and mounting
export { app };

// Start if run directly
if (require.main === module) {
  startFacilitator();
}
