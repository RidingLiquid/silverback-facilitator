/**
 * Price Cache Service
 *
 * Fetches token prices from DexScreener and caches them
 * for efficient USD↔token conversions.
 *
 * - Background refresh every 5 minutes
 * - Zero latency on price lookups (cache only)
 * - Fallback to last known price if fetch fails
 */

import { SUPPORTED_TOKENS, TOKEN_ADDRESSES } from '../config/tokens';

// ============================================================================
// Types
// ============================================================================

export interface TokenPrice {
  symbol: string;
  address: string;
  priceUsd: number;
  updatedAt: Date;
  source: 'dexscreener' | 'hardcoded' | 'fallback';
}

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  baseToken: {
    address: string;
    symbol: string;
  };
  priceUsd: string;
  liquidity?: {
    usd: number;
  };
}

interface DexScreenerResponse {
  pairs: DexScreenerPair[] | null;
}

// ============================================================================
// Configuration
// ============================================================================

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 10000; // 10 seconds

// Hardcoded prices for stablecoins (always $1)
const STABLECOIN_PRICES: Record<string, number> = {
  USDC: 1.0,
  USDT: 1.0,
  DAI: 1.0,
  USDbC: 1.0,
};

// Fallback prices (used if DexScreener fails and no cache)
const FALLBACK_PRICES: Record<string, number> = {
  BACK: 0.00005, // ~200 BACK = $0.01
  VIRTUAL: 1.5,
  WETH: 2500,
  cbBTC: 45000,
  ...STABLECOIN_PRICES,
};

// ============================================================================
// Price Cache
// ============================================================================

const priceCache = new Map<string, TokenPrice>();
let refreshInterval: NodeJS.Timeout | null = null;
let isInitialized = false;

/**
 * Fetch price from DexScreener for a token
 */
async function fetchDexScreenerPrice(tokenAddress: string): Promise<number | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
      { signal: controller.signal }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[PriceCache] DexScreener returned ${response.status} for ${tokenAddress}`);
      return null;
    }

    const data = await response.json() as DexScreenerResponse;

    if (!data.pairs || data.pairs.length === 0) {
      console.warn(`[PriceCache] No pairs found for ${tokenAddress}`);
      return null;
    }

    // Filter to Base chain pairs and sort by liquidity
    const basePairs = data.pairs
      .filter((p) => p.chainId === 'base')
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));

    if (basePairs.length === 0) {
      // Fallback to any chain if no Base pairs
      const anyPair = data.pairs[0];
      if (anyPair?.priceUsd) {
        return parseFloat(anyPair.priceUsd);
      }
      return null;
    }

    // Use the most liquid Base pair
    const bestPair = basePairs[0];
    if (bestPair?.priceUsd) {
      return parseFloat(bestPair.priceUsd);
    }

    return null;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.warn(`[PriceCache] DexScreener timeout for ${tokenAddress}`);
    } else {
      console.warn(`[PriceCache] DexScreener error for ${tokenAddress}:`, error);
    }
    return null;
  }
}

/**
 * Refresh price for a single token
 */
async function refreshTokenPrice(symbol: string, address: string): Promise<void> {
  // Stablecoins are always $1
  if (STABLECOIN_PRICES[symbol] !== undefined) {
    priceCache.set(symbol, {
      symbol,
      address,
      priceUsd: STABLECOIN_PRICES[symbol],
      updatedAt: new Date(),
      source: 'hardcoded',
    });
    return;
  }

  // Fetch from DexScreener
  const price = await fetchDexScreenerPrice(address);

  if (price !== null && price > 0) {
    priceCache.set(symbol, {
      symbol,
      address,
      priceUsd: price,
      updatedAt: new Date(),
      source: 'dexscreener',
    });
    console.log(`[PriceCache] Updated ${symbol}: $${price.toFixed(6)}`);
  } else {
    // Check if we have an existing cached price
    const existing = priceCache.get(symbol);
    if (existing) {
      // Keep using cached price but mark as stale
      console.log(`[PriceCache] Keeping stale price for ${symbol}: $${existing.priceUsd.toFixed(6)}`);
    } else {
      // Use fallback
      const fallback = FALLBACK_PRICES[symbol];
      if (fallback !== undefined) {
        priceCache.set(symbol, {
          symbol,
          address,
          priceUsd: fallback,
          updatedAt: new Date(),
          source: 'fallback',
        });
        console.log(`[PriceCache] Using fallback for ${symbol}: $${fallback.toFixed(6)}`);
      }
    }
  }
}

/**
 * Refresh all token prices
 */
async function refreshAllPrices(): Promise<void> {
  console.log('[PriceCache] Refreshing all prices...');

  const tokens = Object.entries(SUPPORTED_TOKENS);
  const results = await Promise.allSettled(
    tokens.map(([symbol, token]) => refreshTokenPrice(symbol, token.address))
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  console.log(`[PriceCache] Refresh complete: ${succeeded} succeeded, ${failed} failed`);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the price cache and start background refresh
 */
export async function initPriceCache(): Promise<void> {
  if (isInitialized) {
    console.log('[PriceCache] Already initialized');
    return;
  }

  console.log('[PriceCache] Initializing...');

  // Initial fetch
  await refreshAllPrices();

  // Start background refresh
  refreshInterval = setInterval(refreshAllPrices, REFRESH_INTERVAL_MS);

  isInitialized = true;
  console.log('[PriceCache] Initialized with background refresh every 5 minutes');
}

/**
 * Stop the background refresh (for cleanup)
 */
export function stopPriceCache(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
  isInitialized = false;
  console.log('[PriceCache] Stopped');
}

/**
 * Get cached price for a token (by symbol)
 */
export function getTokenPrice(symbol: string): TokenPrice | null {
  return priceCache.get(symbol.toUpperCase()) || null;
}

/**
 * Get cached price for a token (by address)
 */
export function getTokenPriceByAddress(address: string): TokenPrice | null {
  const normalizedAddress = address.toLowerCase();
  const prices = Array.from(priceCache.values());
  for (const price of prices) {
    if (price.address.toLowerCase() === normalizedAddress) {
      return price;
    }
  }
  return null;
}

/**
 * Get all cached prices
 */
export function getAllPrices(): TokenPrice[] {
  return Array.from(priceCache.values());
}

/**
 * Convert USD amount to token amount
 * @param usdAmount Amount in USD (e.g., 0.01 for 1 cent)
 * @param symbol Token symbol
 * @param decimals Token decimals
 * @returns Token amount in base units (bigint) or null if price unknown
 */
export function usdToToken(usdAmount: number, symbol: string, decimals: number): bigint | null {
  const price = getTokenPrice(symbol);
  if (!price || price.priceUsd <= 0) {
    return null;
  }

  // tokenAmount = usdAmount / priceUsd
  const tokenAmount = usdAmount / price.priceUsd;

  // Convert to base units
  const baseUnits = BigInt(Math.floor(tokenAmount * Math.pow(10, decimals)));

  return baseUnits;
}

/**
 * Convert token amount to USD
 * @param tokenAmount Amount in token base units
 * @param symbol Token symbol
 * @param decimals Token decimals
 * @returns USD amount or null if price unknown
 */
export function tokenToUsd(tokenAmount: bigint, symbol: string, decimals: number): number | null {
  const price = getTokenPrice(symbol);
  if (!price || price.priceUsd <= 0) {
    return null;
  }

  // Convert from base units to human readable
  const humanAmount = Number(tokenAmount) / Math.pow(10, decimals);

  // usdAmount = humanAmount * priceUsd
  return humanAmount * price.priceUsd;
}

/**
 * Get equivalent amount in another token
 * @param amount Amount in source token base units
 * @param fromSymbol Source token symbol
 * @param fromDecimals Source token decimals
 * @param toSymbol Target token symbol
 * @param toDecimals Target token decimals
 * @returns Equivalent amount in target token base units, or null if conversion not possible
 */
export function convertTokenAmount(
  amount: bigint,
  fromSymbol: string,
  fromDecimals: number,
  toSymbol: string,
  toDecimals: number
): bigint | null {
  const usdValue = tokenToUsd(amount, fromSymbol, fromDecimals);
  if (usdValue === null) {
    return null;
  }

  return usdToToken(usdValue, toSymbol, toDecimals);
}

/**
 * Force refresh prices (for manual trigger)
 */
export async function forceRefresh(): Promise<void> {
  await refreshAllPrices();
}

/**
 * Get cache status
 */
export function getCacheStatus(): {
  initialized: boolean;
  tokenCount: number;
  oldestUpdate: Date | null;
  newestUpdate: Date | null;
} {
  const prices = getAllPrices();
  const timestamps = prices.map((p) => p.updatedAt.getTime());

  return {
    initialized: isInitialized,
    tokenCount: prices.length,
    oldestUpdate: timestamps.length > 0 ? new Date(Math.min(...timestamps)) : null,
    newestUpdate: timestamps.length > 0 ? new Date(Math.max(...timestamps)) : null,
  };
}
