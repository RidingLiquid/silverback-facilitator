/**
 * Network Configuration
 *
 * Supported networks and contract addresses for the Silverback Facilitator
 */

// ============================================================================
// Network Configuration
// ============================================================================

export interface NetworkConfig {
  chainId: number;
  caip2: string; // CAIP-2 identifier (e.g., 'eip155:8453')
  name: string;
  rpcUrl: string;
  permit2Address: `0x${string}`;
  x402ProxyAddress: `0x${string}`; // Will be set after deployment
  blockExplorerUrl: string;
  avgBlockTime: number; // seconds
  confirmations: number; // blocks to wait
}

// Canonical Permit2 address (same on all EVM chains via CREATE2)
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as `0x${string}`;

/**
 * x402Permit2Proxy address
 *
 * This contract enforces that funds go to the witness.receiver address.
 * Without it, a malicious facilitator could redirect funds.
 *
 * For Phase 1: We call Permit2 directly (acceptable for trusted facilitator)
 * For Phase 2: Deploy x402Permit2Proxy and use it as spender
 *
 * Set X402_PERMIT2_PROXY_MODE=direct to use Permit2 directly (Phase 1)
 * Set X402_PERMIT2_PROXY_MODE=proxy to use x402Permit2Proxy (Phase 2)
 */
export const X402_PROXY_MODE = (process.env.X402_PERMIT2_PROXY_MODE || 'direct') as 'direct' | 'proxy';

// Canonical x402Permit2Proxy address (will be same on all chains via CREATE2)
export const X402_PERMIT2_PROXY_ADDRESS = (process.env.X402_PERMIT2_PROXY_ADDRESS ||
  '0x0000000000000000000000000000000000000000') as `0x${string}`;

// ============================================================================
// Supported Networks
// ============================================================================

/**
 * Network identifier formats:
 * - CAIP-2: "eip155:8453" (our internal format)
 * - Coinbase: "base", "base-sepolia" (Coinbase CDP format)
 *
 * We support BOTH formats for compatibility with Coinbase x402 facilitator.
 */

export const NETWORKS: Record<string, NetworkConfig> = {
  // Base Mainnet
  'eip155:8453': {
    chainId: 8453,
    caip2: 'eip155:8453',
    name: 'Base',
    // PublicNode: free, no auth required, reliable
    // Note: LlamaNodes had sync issues, Ankr requires API key
    rpcUrl: process.env.BASE_RPC_URL || 'https://base.publicnode.com',
    permit2Address: PERMIT2_ADDRESS,
    x402ProxyAddress: (process.env.X402_PERMIT2_PROXY_ADDRESS || '0x0000000000000000000000000000000000000000') as `0x${string}`,
    blockExplorerUrl: 'https://basescan.org',
    avgBlockTime: 2,
    confirmations: 1,
  },
  // Base Sepolia (testnet)
  'eip155:84532': {
    chainId: 84532,
    caip2: 'eip155:84532',
    name: 'Base Sepolia',
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
    permit2Address: PERMIT2_ADDRESS,
    x402ProxyAddress: (process.env.X402_PERMIT2_PROXY_ADDRESS || '0x0000000000000000000000000000000000000000') as `0x${string}`,
    blockExplorerUrl: 'https://sepolia.basescan.org',
    avgBlockTime: 2,
    confirmations: 1,
  },
};

// ============================================================================
// Coinbase Network Format Mapping
// ============================================================================

/**
 * Maps Coinbase network names to CAIP-2 identifiers
 * Coinbase uses: "base", "base-sepolia"
 * We use: "eip155:8453", "eip155:84532"
 */
const COINBASE_TO_CAIP2: Record<string, string> = {
  'base': 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  'base-mainnet': 'eip155:8453', // Alternative name
};

/**
 * Maps CAIP-2 identifiers to Coinbase network names
 */
const CAIP2_TO_COINBASE: Record<string, string> = {
  'eip155:8453': 'base',
  'eip155:84532': 'base-sepolia',
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Normalize network identifier to CAIP-2 format
 * Accepts both Coinbase format ("base") and CAIP-2 format ("eip155:8453")
 */
export function normalizeNetwork(network: string): string {
  // If it's already CAIP-2 format, return as-is
  if (network.includes(':')) {
    return network;
  }
  // Convert Coinbase format to CAIP-2
  return COINBASE_TO_CAIP2[network.toLowerCase()] || network;
}

/**
 * Convert CAIP-2 to Coinbase format
 */
export function toCoinbaseNetwork(caip2: string): string {
  return CAIP2_TO_COINBASE[caip2] || caip2;
}

/**
 * Get network config by network identifier
 * Accepts both Coinbase format ("base") and CAIP-2 format ("eip155:8453")
 */
export function getNetworkConfig(network: string): NetworkConfig | undefined {
  const normalized = normalizeNetwork(network);
  return NETWORKS[normalized];
}

/**
 * Get network config by chain ID
 */
export function getNetworkByChainId(chainId: number): NetworkConfig | undefined {
  return Object.values(NETWORKS).find((n) => n.chainId === chainId);
}

/**
 * Check if network is supported
 * Accepts both Coinbase format ("base") and CAIP-2 format ("eip155:8453")
 */
export function isNetworkSupported(network: string): boolean {
  const normalized = normalizeNetwork(network);
  return normalized in NETWORKS;
}

/**
 * Get list of supported network identifiers (CAIP-2 format)
 */
export function getSupportedNetworks(): string[] {
  return Object.keys(NETWORKS);
}

/**
 * Get list of supported networks in Coinbase format
 */
export function getSupportedNetworksCoinbase(): string[] {
  return Object.keys(NETWORKS).map(caip2 => CAIP2_TO_COINBASE[caip2] || caip2);
}

/**
 * Parse network identifier to get chain info
 * Accepts both Coinbase format ("base") and CAIP-2 format ("eip155:8453")
 */
export function parseCaip2(network: string): { namespace: string; chainId: number } | null {
  // Normalize to CAIP-2 first
  const normalized = normalizeNetwork(network);

  const match = normalized.match(/^(\w+):(\d+)$/);
  if (!match) return null;
  return {
    namespace: match[1],
    chainId: parseInt(match[2], 10),
  };
}

/**
 * Build CAIP-2 identifier
 */
export function buildCaip2(chainId: number, namespace: string = 'eip155'): string {
  return `${namespace}:${chainId}`;
}

// ============================================================================
// Facilitator Configuration
// ============================================================================

export const FACILITATOR_CONFIG = {
  /** Facilitator name for identification */
  name: process.env.FACILITATOR_NAME || 'Silverback',

  /** Facilitator version */
  version: process.env.FACILITATOR_VERSION || '1.0.0',

  /** Service description */
  description: process.env.FACILITATOR_DESCRIPTION ||
    'Silverback x402 Payment Facilitator - Multi-token Permit2 settlements on Base. $BACK payments are fee-exempt.',

  /** Logo URL */
  logo: process.env.FACILITATOR_LOGO || 'https://www.silverbackdefi.app/assets/silverback%20token.png',

  /** Website URL */
  website: process.env.FACILITATOR_WEBSITE || 'https://www.silverbackdefi.app',

  /** Documentation URL */
  docs: process.env.FACILITATOR_DOCS || 'https://docs.silverbackdefi.app',

  /** Fee model description */
  feeModel: process.env.FACILITATOR_FEE_MODEL || 'Option B: $BACK payments fee-exempt, other tokens 0.1-0.25% fee',

  /** Wallet that receives fees */
  feeRecipient: (process.env.FACILITATOR_FEE_RECIPIENT || '0xD34411a70EffbDd000c529bbF572082ffDcF1794') as `0x${string}`,

  /** Wallet that pays gas for settlements */
  gasWallet: (process.env.FACILITATOR_GAS_WALLET || process.env.FACILITATOR_PRIVATE_KEY) as string,

  /** Maximum gas price willing to pay (in gwei) */
  maxGasPriceGwei: parseInt(process.env.FACILITATOR_MAX_GAS_GWEI || '50', 10),

  /** Settlement timeout in milliseconds */
  settlementTimeoutMs: parseInt(process.env.FACILITATOR_SETTLEMENT_TIMEOUT_MS || '60000', 10),

  /**
   * Token whitelist mode (always enforced)
   * Only curated tokens in tokens.ts are accepted
   * New tokens must apply for listing
   */
  whitelistOnly: true,

  /** Minimum balance to process (prevent dust) */
  minSettlementUsd: parseFloat(process.env.FACILITATOR_MIN_SETTLEMENT_USD || '0.001'),
};
