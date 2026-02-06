/**
 * Deploy X402FeeSplitter Contract
 *
 * This script deploys the fee splitter and configures token fees.
 *
 * Usage:
 *   npx ts-node scripts/deploy-fee-splitter.ts
 *
 * Required env:
 *   FACILITATOR_PRIVATE_KEY - Deployer wallet
 *   FACILITATOR_FEE_RECIPIENT - Treasury address
 *   BASE_RPC_URL - RPC endpoint
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { TOKEN_ADDRESSES } from '../src/config/tokens';

// Token fee configuration (basis points: 10 = 0.1%, 25 = 0.25%)
const TOKEN_FEES: Record<string, number> = {
  // Fee-exempt (0%)
  BACK: 0,

  // Stablecoins (0.1% = 10 bps)
  USDC: 10,
  USDT: 10,
  DAI: 10,
  USDbC: 10,

  // Ecosystem tokens (0.1% = 10 bps)
  VIRTUAL: 10,

  // Blue-chips (0.25% = 25 bps)
  WETH: 25,
  cbBTC: 25,
};

// Default fee for unlisted tokens (0.1%)
const DEFAULT_FEE_BPS = 10;

// Contract bytecode will be compiled - for now we'll use a placeholder
// In production, compile with: forge build or solc
async function main() {
  console.log('🚀 X402FeeSplitter Deployment Script\n');

  // Load config
  const privateKey = process.env.FACILITATOR_PRIVATE_KEY;
  const treasury = process.env.FACILITATOR_FEE_RECIPIENT || '0xD34411a70EffbDd000c529bbF572082ffDcF1794';
  const rpcUrl = process.env.BASE_RPC_URL || 'https://base.publicnode.com';

  if (!privateKey) {
    console.error('❌ FACILITATOR_PRIVATE_KEY not set');
    process.exit(1);
  }

  console.log(`Treasury: ${treasury}`);
  console.log(`RPC: ${rpcUrl}`);
  console.log(`Default Fee: ${DEFAULT_FEE_BPS} bps (${DEFAULT_FEE_BPS / 100}%)\n`);

  // Create clients
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  console.log(`Deployer: ${account.address}\n`);

  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(rpcUrl),
  });

  // Check deployer balance
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Deployer ETH balance: ${Number(balance) / 1e18} ETH`);

  if (balance < BigInt(0.01 * 1e18)) {
    console.error('❌ Insufficient ETH for deployment (need ~0.01 ETH)');
    process.exit(1);
  }

  console.log('\n📋 Token Fee Configuration:');
  console.log('─'.repeat(50));
  for (const [symbol, feeBps] of Object.entries(TOKEN_FEES)) {
    const feePercent = feeBps / 100;
    const status = feeBps === 0 ? '(exempt)' : '';
    console.log(`  ${symbol.padEnd(8)} ${String(feeBps).padStart(3)} bps = ${feePercent.toFixed(2)}% ${status}`);
  }
  console.log('─'.repeat(50));

  console.log('\n⚠️  Contract deployment requires compiled bytecode.');
  console.log('   Run: forge build --contracts contracts/X402FeeSplitter.sol');
  console.log('   Then update this script with the bytecode.\n');

  // After deployment, set token fees
  console.log('📝 After deployment, run setTokenFeesBatch with:');

  const tokens = Object.entries(TOKEN_FEES).map(([symbol, _]) => {
    const address = TOKEN_ADDRESSES[symbol as keyof typeof TOKEN_ADDRESSES];
    return address;
  });

  const fees = Object.values(TOKEN_FEES);

  console.log('\nTokens:', tokens);
  console.log('Fees:', fees);

  // Generate config for facilitator
  console.log('\n📄 Add to .env after deployment:');
  console.log('─'.repeat(50));
  console.log('X402_FEE_SPLITTER_ADDRESS=0x... # deployed address');
  console.log('X402_FEE_SPLITTER_ENABLED=true');
  console.log('─'.repeat(50));
}

main().catch(console.error);
