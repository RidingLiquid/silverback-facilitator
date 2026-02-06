/**
 * Balance Checking Service
 *
 * Verifies token balances and Permit2 allowances for payers.
 */

import { createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';
import type { TokenBalance } from '../types';
import { getNetworkConfig, parseCaip2, PERMIT2_ADDRESS } from '../config/networks';
import { getTokenByAddress } from '../config/tokens';

// ============================================================================
// ERC-20 ABI
// ============================================================================

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
]);

// ============================================================================
// Balance Checking
// ============================================================================

/**
 * Get token balance for an address
 */
export async function getTokenBalance(
  owner: `0x${string}`,
  tokenAddress: `0x${string}`,
  network: string
): Promise<TokenBalance | null> {
  try {
    const networkConfig = getNetworkConfig(network);
    if (!networkConfig) {
      throw new Error(`Unsupported network: ${network}`);
    }

    const client = createPublicClient({
      chain: base, // TODO: Support multiple chains
      transport: http(networkConfig.rpcUrl),
    });

    const [balance, decimals, symbol] = await Promise.all([
      client.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [owner],
      }),
      client.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'decimals',
      }),
      client.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'symbol',
      }),
    ]);

    return {
      token: tokenAddress,
      balance,
      decimals,
      symbol,
    };
  } catch (error) {
    console.error('Failed to get token balance:', error);
    return null;
  }
}

/**
 * Check if payer has sufficient balance for payment
 */
export async function hasSufficientBalance(
  payer: `0x${string}`,
  tokenAddress: `0x${string}`,
  amount: bigint,
  network: string
): Promise<{ sufficient: boolean; balance: bigint; shortfall?: bigint }> {
  const tokenBalance = await getTokenBalance(payer, tokenAddress, network);

  if (!tokenBalance) {
    return { sufficient: false, balance: 0n, shortfall: amount };
  }

  const sufficient = tokenBalance.balance >= amount;

  return {
    sufficient,
    balance: tokenBalance.balance,
    shortfall: sufficient ? undefined : amount - tokenBalance.balance,
  };
}

/**
 * Get Permit2 allowance for a token
 */
export async function getPermit2Allowance(
  owner: `0x${string}`,
  tokenAddress: `0x${string}`,
  network: string
): Promise<bigint> {
  try {
    const networkConfig = getNetworkConfig(network);
    if (!networkConfig) {
      throw new Error(`Unsupported network: ${network}`);
    }

    const client = createPublicClient({
      chain: base,
      transport: http(networkConfig.rpcUrl),
    });

    // Check ERC20 allowance to Permit2 contract
    const allowance = await client.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, PERMIT2_ADDRESS],
    });

    return allowance;
  } catch (error) {
    console.error('Failed to get Permit2 allowance:', error);
    return 0n;
  }
}

/**
 * Check if payer has approved Permit2 for sufficient amount
 */
export async function hasPermit2Approval(
  payer: `0x${string}`,
  tokenAddress: `0x${string}`,
  amount: bigint,
  network: string
): Promise<boolean> {
  const allowance = await getPermit2Allowance(payer, tokenAddress, network);
  return allowance >= amount;
}

/**
 * Validate token is a valid ERC-20
 */
export async function isValidErc20(
  tokenAddress: `0x${string}`,
  network: string
): Promise<boolean> {
  try {
    const networkConfig = getNetworkConfig(network);
    if (!networkConfig) return false;

    const client = createPublicClient({
      chain: base,
      transport: http(networkConfig.rpcUrl),
    });

    // Try to read basic ERC-20 functions
    await Promise.all([
      client.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'decimals',
      }),
      client.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'symbol',
      }),
    ]);

    return true;
  } catch {
    return false;
  }
}

/**
 * Get comprehensive balance check result
 */
export interface BalanceCheckResult {
  hasBalance: boolean;
  hasPermit2Approval: boolean;
  balance: bigint;
  allowance: bigint;
  required: bigint;
  token: {
    address: `0x${string}`;
    symbol: string;
    decimals: number;
  };
  issues: string[];
}

export async function checkPayerReadiness(
  payer: `0x${string}`,
  tokenAddress: `0x${string}`,
  amount: bigint,
  network: string
): Promise<BalanceCheckResult> {
  const issues: string[] = [];

  // Get token info
  const tokenInfo = getTokenByAddress(tokenAddress);
  let decimals = tokenInfo?.decimals || 18;
  let symbol = tokenInfo?.symbol || 'UNKNOWN';

  // Get balance
  const balanceResult = await getTokenBalance(payer, tokenAddress, network);
  const balance = balanceResult?.balance || 0n;

  if (balanceResult) {
    decimals = balanceResult.decimals;
    symbol = balanceResult.symbol;
  }

  // Get Permit2 allowance
  const allowance = await getPermit2Allowance(payer, tokenAddress, network);

  // Check issues
  const hasBalance = balance >= amount;
  const hasApproval = allowance >= amount;

  if (!hasBalance) {
    const shortfall = amount - balance;
    issues.push(`Insufficient balance: needs ${shortfall} more ${symbol}`);
  }

  if (!hasApproval) {
    issues.push(`Permit2 not approved: needs ${amount} ${symbol} allowance`);
  }

  return {
    hasBalance,
    hasPermit2Approval: hasApproval,
    balance,
    allowance,
    required: amount,
    token: {
      address: tokenAddress,
      symbol,
      decimals,
    },
    issues,
  };
}
