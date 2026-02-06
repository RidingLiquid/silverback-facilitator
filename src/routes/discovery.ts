/**
 * Bazaar Discovery Layer
 *
 * Exposes x402 resources for discovery by agents and the Bazaar ecosystem.
 * Allows agents to find and query available paid services.
 *
 * Endpoints:
 * - GET /discovery/resources - List all discoverable x402 resources
 * - GET /discovery/resources/:category - Filter by category
 */

import { Router, Request, Response } from 'express';
import { FACILITATOR_CONFIG } from '../config/networks';
import { getSupportedTokensList } from '../config/tokens';

const router = Router();

// Base URL for Silverback x402 services
const X402_SERVICE_BASE = process.env.X402_SERVICE_URL || 'https://x402.silverbackdefi.app';

// Treasury wallet that receives payments
const TREASURY_WALLET = process.env.X402_WALLET_ADDRESS || '0xD34411a70EffbDd000c529bbF572082ffDcF1794';

// USDC on Base
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/**
 * Silverback x402 Resources
 * These are the paid endpoints available through the x402 service
 */
const SILVERBACK_RESOURCES = [
  // DeFi Intelligence
  {
    id: 'swap-quote',
    url: `${X402_SERVICE_BASE}/api/v1/swap-quote`,
    method: 'POST',
    description: 'Get optimal swap route with price impact analysis',
    category: 'defi',
    tags: ['swap', 'quote', 'routing', 'price-impact'],
    priceUsd: 0.002,
    input: {
      type: 'json',
      schema: {
        tokenIn: { type: 'string', description: 'Input token address' },
        tokenOut: { type: 'string', description: 'Output token address' },
        amountIn: { type: 'string', description: 'Amount to swap' },
      },
      required: ['tokenIn', 'tokenOut', 'amountIn'],
    },
    output: { type: 'json', example: { route: [], priceImpact: '0.5%', expectedOut: '100' } },
  },
  {
    id: 'execute-swap',
    url: `${X402_SERVICE_BASE}/api/v1/swap`,
    method: 'POST',
    description: 'Execute token swap on Base via Permit2',
    category: 'defi',
    tags: ['swap', 'execute', 'trade', 'permit2'],
    priceUsd: 0.05,
    input: {
      type: 'json',
      schema: {
        tokenIn: { type: 'string' },
        tokenOut: { type: 'string' },
        amountIn: { type: 'string' },
        slippage: { type: 'number', description: 'Slippage tolerance (default 0.5%)' },
      },
      required: ['tokenIn', 'tokenOut', 'amountIn'],
    },
    output: { type: 'json', example: { txHash: '0x...', amountOut: '100' } },
  },
  {
    id: 'pool-analysis',
    url: `${X402_SERVICE_BASE}/api/v1/pool-analysis`,
    method: 'POST',
    description: 'Deep liquidity pool analysis with health scoring',
    category: 'defi',
    tags: ['pool', 'liquidity', 'analysis', 'health'],
    priceUsd: 0.005,
    input: {
      type: 'json',
      schema: {
        tokenA: { type: 'string', description: 'First token symbol or address' },
        tokenB: { type: 'string', description: 'Second token symbol or address' },
      },
      required: ['tokenA', 'tokenB'],
    },
    output: { type: 'json', example: { tvl: 1000000, apr: 25.5, healthScore: 85 } },
  },
  {
    id: 'technical-analysis',
    url: `${X402_SERVICE_BASE}/api/v1/technical-analysis`,
    method: 'POST',
    description: 'Full technical analysis with patterns, signals & recommendations',
    category: 'trading',
    tags: ['technical', 'analysis', 'signals', 'patterns'],
    priceUsd: 0.02,
    input: {
      type: 'json',
      schema: {
        token: { type: 'string', description: 'Token symbol (e.g., ETH, BTC)' },
        timeframe: { type: 'string', description: 'Timeframe (1h, 4h, 1d)' },
      },
      required: ['token'],
    },
    output: { type: 'json', example: { trend: 'bullish', signals: [], support: 2800, resistance: 3200 } },
  },
  {
    id: 'defi-yield',
    url: `${X402_SERVICE_BASE}/api/v1/defi-yield`,
    method: 'POST',
    description: 'Risk-adjusted DeFi yield intelligence with portfolio allocation',
    category: 'defi',
    tags: ['yield', 'farming', 'apy', 'risk'],
    priceUsd: 0.02,
    input: {
      type: 'json',
      schema: {
        token: { type: 'string', description: 'Token to find yields for (optional)' },
        riskTolerance: { type: 'string', enum: ['low', 'medium', 'high'] },
        amount: { type: 'string', description: 'Amount to deploy' },
      },
      required: [],
    },
    output: { type: 'json', example: { opportunities: [], recommended: {} } },
  },
  {
    id: 'token-audit',
    url: `${X402_SERVICE_BASE}/api/v1/token-audit`,
    method: 'POST',
    description: 'Comprehensive token security audit - honeypot detection, tax analysis, ownership risks',
    category: 'security',
    tags: ['audit', 'security', 'honeypot', 'rugpull'],
    priceUsd: 0.01,
    input: {
      type: 'json',
      schema: {
        tokenAddress: { type: 'string', description: 'Token contract address' },
      },
      required: ['tokenAddress'],
    },
    output: { type: 'json', example: { safe: true, risks: [], score: 85 } },
  },
  {
    id: 'arbitrage-scanner',
    url: `${X402_SERVICE_BASE}/api/v1/arbitrage-scanner`,
    method: 'POST',
    description: 'Cross-DEX arbitrage scanner with spread analysis',
    category: 'trading',
    tags: ['arbitrage', 'dex', 'spread', 'opportunity'],
    priceUsd: 0.02,
    input: {
      type: 'json',
      schema: {
        token: { type: 'string', description: 'Token to scan for arbitrage' },
        minSpread: { type: 'number', description: 'Minimum spread % (default 0.5)' },
      },
      required: ['token'],
    },
    output: { type: 'json', example: { opportunities: [], bestSpread: 1.2 } },
  },
  {
    id: 'whale-tracker',
    url: `${X402_SERVICE_BASE}/api/v1/whale-tracker`,
    method: 'POST',
    description: 'Track whale wallet movements and large transactions',
    category: 'analytics',
    tags: ['whale', 'tracking', 'transactions', 'alerts'],
    priceUsd: 0.01,
    input: {
      type: 'json',
      schema: {
        token: { type: 'string', description: 'Token to track' },
        minAmount: { type: 'string', description: 'Minimum transaction size' },
      },
      required: ['token'],
    },
    output: { type: 'json', example: { recentMoves: [], netFlow: 'inflow' } },
  },
  // Market Data
  {
    id: 'gas-price',
    url: `${X402_SERVICE_BASE}/api/v1/gas-price`,
    method: 'GET',
    description: 'Current gas prices on Base chain',
    category: 'infrastructure',
    tags: ['gas', 'oracle', 'base', 'fees'],
    priceUsd: 0.001,
    input: { type: 'none' },
    output: { type: 'json', example: { gasPrice: { gwei: '0.003' }, estimates: {} } },
  },
  {
    id: 'top-coins',
    url: `${X402_SERVICE_BASE}/api/v1/top-coins`,
    method: 'GET',
    description: 'Top cryptocurrencies ranked by market cap with price data',
    category: 'market-data',
    tags: ['coins', 'marketcap', 'prices', 'ranking'],
    priceUsd: 0.001,
    input: { type: 'query', params: { limit: 'number (default 50)' } },
    output: { type: 'json', example: { coins: [] } },
  },
  {
    id: 'top-pools',
    url: `${X402_SERVICE_BASE}/api/v1/top-pools`,
    method: 'GET',
    description: 'Top Base chain pools by APR',
    category: 'defi',
    tags: ['pools', 'apr', 'liquidity', 'base'],
    priceUsd: 0.001,
    input: { type: 'query', params: { limit: 'number (default 20)' } },
    output: { type: 'json', example: { pools: [] } },
  },
  {
    id: 'top-protocols',
    url: `${X402_SERVICE_BASE}/api/v1/top-protocols`,
    method: 'GET',
    description: 'Top DeFi protocols by TVL',
    category: 'defi',
    tags: ['protocols', 'tvl', 'defi', 'ranking'],
    priceUsd: 0.001,
    input: { type: 'query', params: { limit: 'number (default 20)' } },
    output: { type: 'json', example: { protocols: [] } },
  },
  {
    id: 'trending-tokens',
    url: `${X402_SERVICE_BASE}/api/v1/trending-tokens`,
    method: 'GET',
    description: 'Chain-specific trending tokens from CoinGecko On-Chain API',
    category: 'market-data',
    tags: ['trending', 'tokens', 'coingecko', 'onchain'],
    priceUsd: 0.001,
    input: { type: 'query', params: { chain: 'string (default base)' } },
    output: { type: 'json', example: { tokens: [] } },
  },
  // Backtesting
  {
    id: 'backtest',
    url: `${X402_SERVICE_BASE}/api/v1/backtest`,
    method: 'POST',
    description: 'Strategy backtest with historical data',
    category: 'trading',
    tags: ['backtest', 'strategy', 'historical', 'performance'],
    priceUsd: 0.10,
    input: {
      type: 'json',
      schema: {
        strategy: { type: 'string', description: 'Strategy name or parameters' },
        token: { type: 'string' },
        startDate: { type: 'string' },
        endDate: { type: 'string' },
      },
      required: ['strategy', 'token'],
    },
    output: { type: 'json', example: { returns: 15.5, sharpe: 1.2, maxDrawdown: -8.5 } },
  },
  // ERC-8004 Agent Discovery
  {
    id: 'agent-reputation',
    url: `${X402_SERVICE_BASE}/api/v1/agent-reputation`,
    method: 'GET',
    description: 'Query ERC-8004 reputation for any agent',
    category: 'agents',
    tags: ['erc8004', 'reputation', 'agent', 'trust'],
    priceUsd: 0.001,
    input: { type: 'query', params: { agentAddress: 'string' } },
    output: { type: 'json', example: { reputation: 85, interactions: 150, verified: true } },
  },
  {
    id: 'agent-discover',
    url: `${X402_SERVICE_BASE}/api/v1/agent-discover`,
    method: 'GET',
    description: 'Discover ERC-8004 agents by reputation and capability',
    category: 'agents',
    tags: ['erc8004', 'discovery', 'agents', 'search'],
    priceUsd: 0.002,
    input: { type: 'query', params: { capability: 'string', minReputation: 'number' } },
    output: { type: 'json', example: { agents: [] } },
  },
  // Correlation Analysis
  {
    id: 'correlation-matrix',
    url: `${X402_SERVICE_BASE}/api/v1/correlation-matrix`,
    method: 'POST',
    description: 'Calculate price correlations between multiple tokens',
    category: 'analytics',
    tags: ['correlation', 'analysis', 'portfolio', 'risk'],
    priceUsd: 0.005,
    input: {
      type: 'json',
      schema: {
        tokens: { type: 'array', description: 'Array of token symbols' },
        timeframe: { type: 'string', description: 'Analysis period (7d, 30d, 90d)' },
      },
      required: ['tokens'],
    },
    output: { type: 'json', example: { matrix: [], insights: [] } },
  },
];

/**
 * Format resource for x402 discovery response
 */
function formatResource(resource: typeof SILVERBACK_RESOURCES[0]) {
  const priceInUsdcUnits = Math.round(resource.priceUsd * 1_000_000); // USDC has 6 decimals

  return {
    resource: resource.url,
    x402Version: 2,
    description: resource.description,
    category: resource.category,
    tags: resource.tags,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453', // Base mainnet
        asset: USDC_ADDRESS,
        amount: priceInUsdcUnits.toString(),
        payTo: TREASURY_WALLET,
        maxTimeoutSeconds: 300,
        extra: {
          name: 'USD Coin',
          version: '2',
        },
      },
    ],
    metadata: {
      provider: FACILITATOR_CONFIG.name,
      providerUrl: FACILITATOR_CONFIG.website,
      logo: FACILITATOR_CONFIG.logo,
      method: resource.method,
      input: resource.input,
      output: resource.output,
    },
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * GET /discovery/resources
 * List all discoverable x402 resources
 */
router.get('/resources', (req: Request, res: Response) => {
  const { category, tag, limit = '50', offset = '0' } = req.query;

  let resources = [...SILVERBACK_RESOURCES];

  // Filter by category
  if (category && typeof category === 'string') {
    resources = resources.filter((r) => r.category === category);
  }

  // Filter by tag
  if (tag && typeof tag === 'string') {
    resources = resources.filter((r) => r.tags.includes(tag));
  }

  // Pagination
  const limitNum = Math.min(parseInt(limit as string, 10) || 50, 100);
  const offsetNum = parseInt(offset as string, 10) || 0;
  const total = resources.length;
  resources = resources.slice(offsetNum, offsetNum + limitNum);

  res.json({
    success: true,
    data: {
      resources: resources.map(formatResource),
      total,
      limit: limitNum,
      offset: offsetNum,
      categories: [...new Set(SILVERBACK_RESOURCES.map((r) => r.category))],
      tags: [...new Set(SILVERBACK_RESOURCES.flatMap((r) => r.tags))],
    },
    provider: {
      name: FACILITATOR_CONFIG.name,
      version: FACILITATOR_CONFIG.version,
      website: FACILITATOR_CONFIG.website,
      logo: FACILITATOR_CONFIG.logo,
    },
  });
});

/**
 * GET /discovery/resources/:id
 * Get a specific resource by ID
 */
router.get('/resources/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const resource = SILVERBACK_RESOURCES.find((r) => r.id === id);

  if (!resource) {
    return res.status(404).json({
      success: false,
      error: 'Resource not found',
      message: `No resource with id '${id}'`,
    });
  }

  res.json({
    success: true,
    data: formatResource(resource),
  });
});

/**
 * GET /discovery/categories
 * List all available categories
 */
router.get('/categories', (_req: Request, res: Response) => {
  const categories = [...new Set(SILVERBACK_RESOURCES.map((r) => r.category))];
  const categoryCounts = categories.map((cat) => ({
    category: cat,
    count: SILVERBACK_RESOURCES.filter((r) => r.category === cat).length,
  }));

  res.json({
    success: true,
    data: {
      categories: categoryCounts,
      total: categories.length,
    },
  });
});

/**
 * GET /discovery/tags
 * List all available tags
 */
router.get('/tags', (_req: Request, res: Response) => {
  const allTags = SILVERBACK_RESOURCES.flatMap((r) => r.tags);
  const tagCounts: Record<string, number> = {};
  allTags.forEach((tag) => {
    tagCounts[tag] = (tagCounts[tag] || 0) + 1;
  });

  const tags = Object.entries(tagCounts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);

  res.json({
    success: true,
    data: {
      tags,
      total: tags.length,
    },
  });
});

/**
 * GET /discovery/info
 * Discovery service info
 */
router.get('/info', (_req: Request, res: Response) => {
  const supportedTokens = getSupportedTokensList();

  res.json({
    success: true,
    data: {
      name: `${FACILITATOR_CONFIG.name} Discovery`,
      version: FACILITATOR_CONFIG.version,
      description: 'Bazaar discovery layer for Silverback x402 resources',
      x402Version: 2,
      resourceCount: SILVERBACK_RESOURCES.length,
      categories: [...new Set(SILVERBACK_RESOURCES.map((r) => r.category))],
      supportedPaymentTokens: supportedTokens.map((t) => ({
        symbol: t.symbol,
        address: t.address,
        network: 'eip155:8453',
      })),
      provider: {
        name: FACILITATOR_CONFIG.name,
        website: FACILITATOR_CONFIG.website,
        logo: FACILITATOR_CONFIG.logo,
        docs: FACILITATOR_CONFIG.docs,
      },
    },
  });
});

export default router;
