/**
 * Supported Token Registry (Curated Whitelist)
 *
 * Only quality, established tokens are accepted.
 * New tokens can apply for listing on a case-by-case basis.
 *
 * Pricing Model:
 * - $BACK: Fee-exempt + 15% discount (drives $BACK adoption)
 * - Stablecoins: 0.1% fee
 * - Blue-chip assets: 0.25% fee
 */

import type { SupportedToken } from '../types';

// ============================================================================
// Token Addresses (Base Mainnet)
// ============================================================================

export const TOKEN_ADDRESSES = {
  // ─────────────────────────────────────────────────────────────────────────
  // Silverback Native Token
  // ─────────────────────────────────────────────────────────────────────────
  BACK: '0x558881c4959e9cf961a7E1815FCD6586906babd2' as `0x${string}`,

  // ─────────────────────────────────────────────────────────────────────────
  // Stablecoins
  // ─────────────────────────────────────────────────────────────────────────
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`,
  USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2' as `0x${string}`,
  DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb' as `0x${string}`,
  USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA' as `0x${string}`,

  // ─────────────────────────────────────────────────────────────────────────
  // Ecosystem Tokens
  // ─────────────────────────────────────────────────────────────────────────
  VIRTUAL: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b' as `0x${string}`,

  // ─────────────────────────────────────────────────────────────────────────
  // Blue-Chip Assets (ETH, BTC)
  // ─────────────────────────────────────────────────────────────────────────
  WETH: '0x4200000000000000000000000000000000000006' as `0x${string}`,
  cbBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' as `0x${string}`,
} as const;

// ============================================================================
// Curated Token Whitelist
// ============================================================================

/**
 * CURATED WHITELIST - Only these tokens are accepted
 *
 * To request a new token listing:
 * - Token must have established liquidity
 * - Token must not be a scam/rug
 * - Submit request to Silverback team
 */
export const SUPPORTED_TOKENS: Record<string, SupportedToken> = {
  // ═══════════════════════════════════════════════════════════════════════════
  // $BACK - Silverback Native Token (Fee-Exempt)
  // Discount is applied at the resource server level, not here
  // ═══════════════════════════════════════════════════════════════════════════
  BACK: {
    address: TOKEN_ADDRESSES.BACK,
    symbol: 'BACK',
    name: 'Silverback',
    decimals: 18,
    feePercent: 0,
    feeExempt: true,
    coingeckoId: undefined,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Stablecoins (0.1% fee)
  // ═══════════════════════════════════════════════════════════════════════════
  USDC: {
    address: TOKEN_ADDRESSES.USDC,
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    feePercent: 0.1,
    feeExempt: false,
    coingeckoId: 'usd-coin',
  },

  USDT: {
    address: TOKEN_ADDRESSES.USDT,
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    feePercent: 0.1,
    feeExempt: false,
    coingeckoId: 'tether',
  },

  DAI: {
    address: TOKEN_ADDRESSES.DAI,
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    decimals: 18,
    feePercent: 0.1,
    feeExempt: false,
    coingeckoId: 'dai',
  },

  USDbC: {
    address: TOKEN_ADDRESSES.USDbC,
    symbol: 'USDbC',
    name: 'USD Base Coin (Bridged)',
    decimals: 6,
    feePercent: 0.1,
    feeExempt: false,
    coingeckoId: 'bridged-usd-coin-base',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Ecosystem Tokens (0.1% fee - encourage ecosystem usage)
  // ═══════════════════════════════════════════════════════════════════════════
  VIRTUAL: {
    address: TOKEN_ADDRESSES.VIRTUAL,
    symbol: 'VIRTUAL',
    name: 'Virtuals Protocol',
    decimals: 18,
    feePercent: 0.1,
    feeExempt: false,
    coingeckoId: 'virtual-protocol',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Blue-Chip Assets (0.25% fee)
  // ═══════════════════════════════════════════════════════════════════════════
  WETH: {
    address: TOKEN_ADDRESSES.WETH,
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    feePercent: 0.25,
    feeExempt: false,
    coingeckoId: 'weth',
  },

  cbBTC: {
    address: TOKEN_ADDRESSES.cbBTC,
    symbol: 'cbBTC',
    name: 'Coinbase Wrapped BTC',
    decimals: 8,
    feePercent: 0.25,
    feeExempt: false,
    coingeckoId: 'coinbase-wrapped-btc',
  },
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get token config by address (case-insensitive)
 */
export function getTokenByAddress(address: string): SupportedToken | undefined {
  const normalizedAddress = address.toLowerCase();
  return Object.values(SUPPORTED_TOKENS).find(
    (token) => token.address.toLowerCase() === normalizedAddress
  );
}

/**
 * Get token config by symbol
 */
export function getTokenBySymbol(symbol: string): SupportedToken | undefined {
  return SUPPORTED_TOKENS[symbol.toUpperCase()];
}

/**
 * Check if token is in the curated whitelist
 */
export function isTokenWhitelisted(address: string): boolean {
  return getTokenByAddress(address) !== undefined;
}

/**
 * Get fee percentage for a whitelisted token
 * Returns undefined for non-whitelisted tokens (they should be rejected)
 */
export function getTokenFeePercent(address: string): number {
  const token = getTokenByAddress(address);
  if (!token) {
    // Token not whitelisted - this should have been caught earlier
    // Return -1 to indicate error (caller should reject)
    return -1;
  }
  return token.feeExempt ? 0 : (token.feePercent || 0.1);
}

/**
 * Get discount percentage for a token
 * Only $BACK has a discount currently
 */
export function getTokenDiscountPercent(address: string): number {
  const token = getTokenByAddress(address);
  return token?.discountPercent || 0;
}

/**
 * Calculate fee amount in token base units
 */
export function calculateFeeAmount(amount: bigint, feePercent: number): bigint {
  if (feePercent <= 0) return 0n;
  const basisPoints = BigInt(Math.floor(feePercent * 100));
  return (amount * basisPoints) / 10000n;
}

/**
 * Calculate net amount after fee
 */
export function calculateNetAmount(amount: bigint, feePercent: number): bigint {
  const fee = calculateFeeAmount(amount, feePercent);
  return amount - fee;
}

/**
 * Get all supported tokens as array
 */
export function getSupportedTokensList(): SupportedToken[] {
  return Object.values(SUPPORTED_TOKENS);
}

/**
 * Add a token to the whitelist (runtime - for admin use)
 * In production, this should require authentication
 */
export function addSupportedToken(token: SupportedToken): void {
  SUPPORTED_TOKENS[token.symbol] = token;
  console.log(`[Tokens] Added ${token.symbol} (${token.address}) to whitelist`);
}

/**
 * Remove a token from the whitelist (runtime - for admin use)
 */
export function removeSupportedToken(symbol: string): boolean {
  if (symbol === 'BACK') {
    console.warn('[Tokens] Cannot remove $BACK from whitelist');
    return false;
  }
  if (SUPPORTED_TOKENS[symbol]) {
    delete SUPPORTED_TOKENS[symbol];
    console.log(`[Tokens] Removed ${symbol} from whitelist`);
    return true;
  }
  return false;
}

/**
 * Alias for getTokenDiscountPercent
 */
export const getTokenDiscount = getTokenDiscountPercent;

/**
 * Format token amount for display (human readable)
 */
export function formatTokenAmount(amount: bigint, decimals: number = 18): string {
  const divisor = BigInt(10 ** decimals);
  const wholePart = amount / divisor;
  const fractionalPart = amount % divisor;

  if (fractionalPart === 0n) {
    return wholePart.toString();
  }

  const fractionalStr = fractionalPart.toString().padStart(decimals, '0');
  const trimmed = fractionalStr.replace(/0+$/, '');

  if (trimmed === '') {
    return wholePart.toString();
  }

  const displayFractional = trimmed.slice(0, 6);
  return `${wholePart}.${displayFractional}`;
}
