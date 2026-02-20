/**
 * Silverback x402 Facilitator — Entry Point
 *
 * Lean Express server wrapping the @x402 SDK facilitator.
 * Supports Base (EVM) and Solana (SVM) USDC settlements.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import routes from './routes';
import { initializeEvm, initializeSkale, initializeSvm, isReady, getAddresses } from './facilitator';

const app = express();
const PORT = parseInt(process.env.X402_FACILITATOR_PORT || process.env.PORT || '3402', 10);

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());

// Rate limiting (in-memory, 100 req/min/IP)
const requestCounts = new Map<string, { count: number; resetAt: number }>();

app.use((req, res, next) => {
  if (req.path === '/health') return next();

  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const record = requestCounts.get(key);

  if (!record || record.resetAt < now) {
    requestCounts.set(key, { count: 1, resetAt: now + 60000 });
    return next();
  }

  record.count++;
  if (record.count > 100) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }
  next();
});

// Cleanup stale rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of requestCounts.entries()) {
    if (record.resetAt < now) requestCounts.delete(key);
  }
}, 60000);

// Request logging
app.use((req, _res, next) => {
  if (req.path !== '/health') {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// ─── Routes ──────────────────────────────────────────────────────────────────

app.use('/', routes);

// Root info
app.get('/', (_req, res) => {
  res.json({
    name: 'Silverback x402 Facilitator',
    version: '2.0.0',
    description: 'x402 payment settlement — Base USDC + SKALE USDC + Solana USDC',
    endpoints: {
      '/supported': 'GET  — List supported kinds, extensions, signers',
      '/verify': 'POST — Verify payment signature',
      '/settle': 'POST — Execute on-chain settlement',
      '/health': 'GET  — Operational status',
    },
  });
});

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Startup ─────────────────────────────────────────────────────────────────

async function start() {
  console.log('');
  console.log('='.repeat(50));
  console.log('  Silverback x402 Facilitator v2.0.0');
  console.log('='.repeat(50));

  // Initialize EVM (required)
  const evmKey = process.env.FACILITATOR_PRIVATE_KEY;
  if (!evmKey) {
    console.error('[startup] FACILITATOR_PRIVATE_KEY not set');
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
    console.warn('[startup] Running without EVM — settlements will fail');
  } else {
    initializeEvm(evmKey, process.env.BASE_RPC_URL);

    // Initialize SKALE (uses same EVM key, zero gas)
    initializeSkale(evmKey);
  }

  // Initialize SVM (optional)
  const svmKey = process.env.SOLANA_FACILITATOR_PRIVATE_KEY;
  if (svmKey) {
    await initializeSvm(svmKey);
  } else {
    console.log('[startup] No SOLANA_FACILITATOR_PRIVATE_KEY — Solana disabled');
  }

  const addrs = getAddresses();

  app.listen(PORT, () => {
    console.log('');
    console.log(`  Port:     ${PORT}`);
    console.log(`  Mode:     ${process.env.NODE_ENV || 'development'}`);
    console.log(`  EVM:      ${addrs.evm || 'not configured'}`);
    console.log(`  SKALE:    ${addrs.skale || 'not configured'}`);
    console.log(`  Solana:   ${addrs.svm || 'not configured'}`);
    console.log(`  Ready:    ${isReady()}`);
    console.log('');
    console.log('  GET  /supported');
    console.log('  POST /verify');
    console.log('  POST /settle');
    console.log('  GET  /health');
    console.log('');
    console.log('='.repeat(50));
  });
}

start().catch((err) => {
  console.error('[startup] Fatal:', err);
  process.exit(1);
});

export { app };
