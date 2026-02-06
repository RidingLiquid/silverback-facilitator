/**
 * GET /supported
 *
 * Returns supported payment schemes, networks, and tokens.
 */

import { Router, Request, Response } from 'express';
import { privateKeyToAccount } from 'viem/accounts';
import type { SupportedResponse } from '../types';
import { getSupportedNetworks, getSupportedNetworksCoinbase, FACILITATOR_CONFIG, PERMIT2_ADDRESS } from '../config/networks';
import {
  getSupportedTokensList,
  getTokenBySymbol,
  getTokenByAddress,
  calculateFeeAmount,
  calculateNetAmount,
} from '../config/tokens';
import {
  getTokenPrice,
  getAllPrices,
  usdToToken,
  tokenToUsd,
  getCacheStatus,
  forceRefresh,
} from '../services/price-cache';

/**
 * Get the facilitator's wallet address (for Permit2 spender)
 */
function getFacilitatorAddress(): `0x${string}` | null {
  const privateKey = process.env.FACILITATOR_PRIVATE_KEY;
  if (!privateKey) return null;
  try {
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    return account.address;
  } catch {
    return null;
  }
}

const router = Router();

/**
 * GET /supported
 *
 * Returns the facilitator's supported configurations.
 * x402 spec compliant with extra fields for convenience.
 */
router.get('/', (_req: Request, res: Response) => {
  // Build x402 spec compliant "kinds" array
  const kinds = getSupportedNetworksCoinbase().map(network => ({
    x402Version: 1 as const,
    scheme: 'exact' as const,
    network,
  }));

  const response = {
    // x402 spec required field
    kinds,
    // Extra fields for convenience (not in x402 spec)
    x402Version: 1,
    schemes: ['exact'],
    networks: getSupportedNetworks(), // CAIP-2 format: ["eip155:8453"]
    networksCoinbase: getSupportedNetworksCoinbase(), // Coinbase format: ["base"]
    tokens: getSupportedTokensList(),
    facilitator: {
      name: FACILITATOR_CONFIG.name,
      version: FACILITATOR_CONFIG.version,
      description: FACILITATOR_CONFIG.description,
      feeModel: FACILITATOR_CONFIG.feeModel,
      address: getFacilitatorAddress(), // Permit2 spender address
      permit2: PERMIT2_ADDRESS,
      // Branding metadata
      logo: FACILITATOR_CONFIG.logo,
      website: FACILITATOR_CONFIG.website,
      docs: FACILITATOR_CONFIG.docs,
    },
  };

  res.json(response);
});

/**
 * GET /supported/tokens
 *
 * Returns just the supported tokens with details including USD prices.
 */
router.get('/tokens', (_req: Request, res: Response) => {
  const tokens = getSupportedTokensList();
  const prices = getAllPrices();
  const cacheStatus = getCacheStatus();

  // Merge token info with prices
  const tokensWithPrices = tokens.map((token) => {
    const price = prices.find((p) => p.symbol === token.symbol);
    return {
      ...token,
      priceUsd: price?.priceUsd || null,
      priceSource: price?.source || null,
      priceUpdatedAt: price?.updatedAt || null,
    };
  });

  res.json({
    tokens: tokensWithPrices,
    feeExemptTokens: tokens.filter((t) => t.feeExempt).map((t) => t.symbol),
    discountTokens: tokens
      .filter((t) => t.discountPercent && t.discountPercent > 0)
      .map((t) => ({ symbol: t.symbol, discount: `${t.discountPercent}%` })),
    priceCache: {
      initialized: cacheStatus.initialized,
      tokenCount: cacheStatus.tokenCount,
      lastUpdate: cacheStatus.newestUpdate,
    },
  });
});

/**
 * GET /supported/networks
 *
 * Returns just the supported networks.
 */
router.get('/networks', (_req: Request, res: Response) => {
  res.json({
    networks: getSupportedNetworks(),
  });
});

/**
 * GET /supported/calculate-pricing
 *
 * Helper endpoint for agents to understand fee impact and price accordingly.
 *
 * Query params:
 * - amount: The amount (required) - can be gross amount or desired net
 * - token: Token symbol (e.g., "USDC") or address (required)
 * - mode: "gross" (default) = amount is what payer pays, calculate net
 *         "net" = amount is what agent wants to receive, calculate suggested price
 *
 * Examples:
 *   /calculate-pricing?amount=0.10&token=USDC
 *   /calculate-pricing?amount=0.10&token=USDC&mode=net
 *   /calculate-pricing?amount=1000000&token=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&decimals=6
 */
router.get('/calculate-pricing', (req: Request, res: Response) => {
  const { amount, token, mode = 'gross', decimals: decimalsParam } = req.query;

  // Validate amount
  if (!amount || typeof amount !== 'string') {
    res.status(400).json({ error: 'Missing required parameter: amount' });
    return;
  }

  // Validate token
  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'Missing required parameter: token (symbol or address)' });
    return;
  }

  // Find token config
  const tokenConfig = token.startsWith('0x')
    ? getTokenByAddress(token)
    : getTokenBySymbol(token);

  if (!tokenConfig) {
    res.status(400).json({
      error: `Token not supported: ${token}`,
      supportedTokens: getSupportedTokensList().map((t) => t.symbol),
    });
    return;
  }

  const feePercent = tokenConfig.feeExempt ? 0 : (tokenConfig.feePercent || 0);
  const decimals = decimalsParam ? parseInt(decimalsParam as string, 10) : tokenConfig.decimals;

  // Parse amount - support both human readable (0.10) and raw units (100000)
  let amountRaw: bigint;
  const amountStr = amount as string;

  if (amountStr.includes('.')) {
    // Human readable format (e.g., "0.10")
    const [whole, fraction = ''] = amountStr.split('.');
    const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
    amountRaw = BigInt(whole + paddedFraction);
  } else {
    // Raw units format (e.g., "100000")
    amountRaw = BigInt(amountStr);
  }

  if (mode === 'net') {
    // Agent wants to receive X net, calculate what payer should pay
    // netAmount = grossAmount - fee
    // netAmount = grossAmount - (grossAmount * feePercent / 100)
    // netAmount = grossAmount * (1 - feePercent/100)
    // grossAmount = netAmount / (1 - feePercent/100)
    const desiredNet = amountRaw;
    const multiplier = 10000n - BigInt(Math.floor(feePercent * 100));
    const suggestedGross = (desiredNet * 10000n) / multiplier;
    const actualFee = calculateFeeAmount(suggestedGross, feePercent);
    const actualNet = suggestedGross - actualFee;

    res.json({
      mode: 'net',
      token: tokenConfig.symbol,
      tokenAddress: tokenConfig.address,
      decimals,
      feePercent,
      feeExempt: tokenConfig.feeExempt || false,
      desiredNetAmount: desiredNet.toString(),
      desiredNetHuman: formatAmount(desiredNet, decimals),
      suggestedGrossAmount: suggestedGross.toString(),
      suggestedGrossHuman: formatAmount(suggestedGross, decimals),
      actualFeeAmount: actualFee.toString(),
      actualFeeHuman: formatAmount(actualFee, decimals),
      actualNetAmount: actualNet.toString(),
      actualNetHuman: formatAmount(actualNet, decimals),
      note: `Set your price to ${formatAmount(suggestedGross, decimals)} ${tokenConfig.symbol} to receive ~${formatAmount(actualNet, decimals)} ${tokenConfig.symbol} after fees`,
    });
  } else {
    // Default: amount is what payer pays, calculate what agent receives
    const grossAmount = amountRaw;
    const feeAmount = calculateFeeAmount(grossAmount, feePercent);
    const netAmount = calculateNetAmount(grossAmount, feePercent);

    res.json({
      mode: 'gross',
      token: tokenConfig.symbol,
      tokenAddress: tokenConfig.address,
      decimals,
      feePercent,
      feeExempt: tokenConfig.feeExempt || false,
      grossAmount: grossAmount.toString(),
      grossHuman: formatAmount(grossAmount, decimals),
      feeAmount: feeAmount.toString(),
      feeHuman: formatAmount(feeAmount, decimals),
      netAmount: netAmount.toString(),
      netHuman: formatAmount(netAmount, decimals),
      note: `Payer pays ${formatAmount(grossAmount, decimals)} ${tokenConfig.symbol}, agent receives ${formatAmount(netAmount, decimals)} ${tokenConfig.symbol} (fee: ${formatAmount(feeAmount, decimals)})`,
    });
  }
});

/**
 * Helper to format raw amount to human readable
 */
function formatAmount(amount: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const whole = amount / divisor;
  const fraction = amount % divisor;

  if (fraction === 0n) {
    return whole.toString();
  }

  const fractionStr = fraction.toString().padStart(decimals, '0');
  const trimmed = fractionStr.replace(/0+$/, '');

  if (trimmed === '') {
    return whole.toString();
  }

  return `${whole}.${trimmed}`;
}

/**
 * GET /supported/convert
 *
 * Convert USD amount to token amount (for dynamic pricing).
 *
 * Query params:
 * - usd: USD amount (required, e.g., "0.01" for 1 cent)
 * - token: Token symbol (required, e.g., "BACK")
 *
 * Example:
 *   /convert?usd=0.02&token=BACK
 *   Response: { tokenAmount: "400000000000000000000", tokenHuman: "400", ... }
 */
router.get('/convert', (req: Request, res: Response) => {
  const { usd, token } = req.query;

  if (!usd || typeof usd !== 'string') {
    res.status(400).json({ error: 'Missing required parameter: usd' });
    return;
  }

  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'Missing required parameter: token' });
    return;
  }

  const tokenConfig = getTokenBySymbol(token);
  if (!tokenConfig) {
    res.status(400).json({
      error: `Token not supported: ${token}`,
      supportedTokens: getSupportedTokensList().map((t) => t.symbol),
    });
    return;
  }

  const usdAmount = parseFloat(usd);
  if (isNaN(usdAmount) || usdAmount <= 0) {
    res.status(400).json({ error: 'Invalid USD amount' });
    return;
  }

  const price = getTokenPrice(tokenConfig.symbol);
  if (!price) {
    res.status(503).json({
      error: 'Price not available',
      message: `No price data for ${tokenConfig.symbol}. Price cache may be initializing.`,
    });
    return;
  }

  const tokenAmount = usdToToken(usdAmount, tokenConfig.symbol, tokenConfig.decimals);
  if (tokenAmount === null) {
    res.status(503).json({
      error: 'Conversion failed',
      message: `Could not convert USD to ${tokenConfig.symbol}`,
    });
    return;
  }

  // Calculate fee-adjusted amounts
  const feePercent = tokenConfig.feeExempt ? 0 : (tokenConfig.feePercent || 0);
  const feeAmount = calculateFeeAmount(tokenAmount, feePercent);
  const netAmount = tokenAmount - feeAmount;

  res.json({
    usdAmount,
    token: tokenConfig.symbol,
    tokenAddress: tokenConfig.address,
    decimals: tokenConfig.decimals,
    priceUsd: price.priceUsd,
    priceSource: price.source,
    priceUpdatedAt: price.updatedAt,
    // Gross amount (what payer pays)
    tokenAmount: tokenAmount.toString(),
    tokenHuman: formatAmount(tokenAmount, tokenConfig.decimals),
    // Fee info
    feePercent,
    feeExempt: tokenConfig.feeExempt || false,
    feeAmount: feeAmount.toString(),
    feeHuman: formatAmount(feeAmount, tokenConfig.decimals),
    // Net amount (what receiver gets)
    netAmount: netAmount.toString(),
    netHuman: formatAmount(netAmount, tokenConfig.decimals),
    // Human readable summary
    note: `$${usdAmount.toFixed(4)} USD = ${formatAmount(tokenAmount, tokenConfig.decimals)} ${tokenConfig.symbol} (receiver gets ${formatAmount(netAmount, tokenConfig.decimals)} after ${feePercent}% fee)`,
  });
});

/**
 * GET /supported/prices
 *
 * Returns current prices for all tokens.
 */
router.get('/prices', (_req: Request, res: Response) => {
  const prices = getAllPrices();
  const status = getCacheStatus();

  res.json({
    prices: prices.map((p) => ({
      symbol: p.symbol,
      address: p.address,
      priceUsd: p.priceUsd,
      source: p.source,
      updatedAt: p.updatedAt,
    })),
    cache: {
      initialized: status.initialized,
      tokenCount: status.tokenCount,
      oldestUpdate: status.oldestUpdate,
      newestUpdate: status.newestUpdate,
    },
  });
});

/**
 * POST /supported/prices/refresh
 *
 * Force refresh all prices (for admin use).
 */
router.post('/prices/refresh', async (_req: Request, res: Response) => {
  try {
    await forceRefresh();
    const prices = getAllPrices();

    res.json({
      success: true,
      message: 'Prices refreshed',
      prices: prices.map((p) => ({
        symbol: p.symbol,
        priceUsd: p.priceUsd,
        source: p.source,
      })),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
