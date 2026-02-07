/**
 * Manage X402FeeSplitter Contract
 *
 * Add/remove facilitators, update treasury, check status.
 *
 * Usage:
 *   npx ts-node scripts/manage-fee-splitter.ts status
 *   npx ts-node scripts/manage-fee-splitter.ts add-facilitator 0x...
 *   npx ts-node scripts/manage-fee-splitter.ts remove-facilitator 0x...
 *   npx ts-node scripts/manage-fee-splitter.ts set-treasury 0x...
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY - Owner wallet (0x3273786c3add9092F3fbF0201013B4532bD780f7)
 *   BASE_RPC_URL - RPC endpoint (optional, defaults to public)
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  getAddress,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const FEE_SPLITTER_ADDRESS = '0x6FDf52EA446B54508f50C35612210c69Ef1C1d9a' as `0x${string}`;

const ABI = parseAbi([
  'function setFacilitator(address facilitator, bool authorized) external',
  'function setTreasury(address _treasury) external',
  'function isFacilitator(address facilitator) external view returns (bool)',
  'function owner() external view returns (address)',
  'function treasury() external view returns (address)',
  'function paused() external view returns (bool)',
  'function facilitatorCount() external view returns (uint256)',
  'function totalSettlements() external view returns (uint256)',
  'function defaultFeeBps() external view returns (uint256)',
  'function getStats() external view returns (uint256 settlements, address treasuryAddr, uint256 defaultFee, uint256 numFacilitators, bool isPaused, bool isWhitelistMode)',
]);

async function main() {
  const command = process.argv[2];
  const arg = process.argv[3];

  const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  if (command === 'status') {
    console.log('\n=== X402FeeSplitter Status ===\n');
    console.log(`Contract: ${FEE_SPLITTER_ADDRESS}`);

    const [stats, owner] = await Promise.all([
      publicClient.readContract({ address: FEE_SPLITTER_ADDRESS, abi: ABI, functionName: 'getStats' }),
      publicClient.readContract({ address: FEE_SPLITTER_ADDRESS, abi: ABI, functionName: 'owner' }),
    ]);

    const [settlements, treasury, defaultFee, numFacilitators, isPaused, isWhitelistMode] = stats;

    console.log(`Owner: ${owner}`);
    console.log(`Treasury: ${treasury}`);
    console.log(`Default Fee: ${defaultFee} bps (${Number(defaultFee) / 100}%)`);
    console.log(`Facilitators: ${numFacilitators}`);
    console.log(`Total Settlements: ${settlements}`);
    console.log(`Paused: ${isPaused}`);
    console.log(`Whitelist Mode: ${isWhitelistMode}`);

    // Check known wallets
    const walletsToCheck = [
      { label: 'New facilitator', address: '0x48380bCf1c09773C9E96901F89A7A6B75E2BBeCC' as `0x${string}` },
      { label: 'Old facilitator (BURNED)', address: '0x21fdEd74C901129977B8e28C2588595163E1e235' as `0x${string}` },
    ];

    console.log('\nFacilitator Whitelist:');
    for (const w of walletsToCheck) {
      const isAuth = await publicClient.readContract({
        address: FEE_SPLITTER_ADDRESS, abi: ABI, functionName: 'isFacilitator', args: [w.address],
      });
      console.log(`  ${w.label} (${w.address.slice(0, 8)}...): ${isAuth ? '✅ authorized' : '❌ NOT authorized'}`);
    }

    return;
  }

  // Write operations need a private key
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    console.error('❌ DEPLOYER_PRIVATE_KEY not set');
    process.exit(1);
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  console.log(`Signer: ${account.address}`);

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(rpcUrl),
  });

  if (command === 'add-facilitator' && arg) {
    const addr = getAddress(arg);
    console.log(`\nAdding facilitator: ${addr}`);

    const isAlready = await publicClient.readContract({
      address: FEE_SPLITTER_ADDRESS, abi: ABI, functionName: 'isFacilitator', args: [addr],
    });

    if (isAlready) {
      console.log('Already authorized, nothing to do.');
      return;
    }

    const hash = await walletClient.writeContract({
      address: FEE_SPLITTER_ADDRESS, abi: ABI, functionName: 'setFacilitator', args: [addr, true],
    });
    console.log(`TX submitted: ${hash}`);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`✅ Confirmed in block ${receipt.blockNumber}`);

  } else if (command === 'remove-facilitator' && arg) {
    const addr = getAddress(arg);
    console.log(`\nRemoving facilitator: ${addr}`);

    const hash = await walletClient.writeContract({
      address: FEE_SPLITTER_ADDRESS, abi: ABI, functionName: 'setFacilitator', args: [addr, false],
    });
    console.log(`TX submitted: ${hash}`);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`✅ Removed in block ${receipt.blockNumber}`);

  } else if (command === 'set-treasury' && arg) {
    const addr = getAddress(arg);
    console.log(`\nUpdating treasury to: ${addr}`);

    const hash = await walletClient.writeContract({
      address: FEE_SPLITTER_ADDRESS, abi: ABI, functionName: 'setTreasury', args: [addr],
    });
    console.log(`TX submitted: ${hash}`);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`✅ Treasury updated in block ${receipt.blockNumber}`);

  } else {
    console.log(`
Usage:
  npx ts-node scripts/manage-fee-splitter.ts status
  npx ts-node scripts/manage-fee-splitter.ts add-facilitator <address>
  npx ts-node scripts/manage-fee-splitter.ts remove-facilitator <address>
  npx ts-node scripts/manage-fee-splitter.ts set-treasury <address>

Env:
  DEPLOYER_PRIVATE_KEY - Owner wallet private key
  BASE_RPC_URL - RPC endpoint (optional)
    `);
  }
}

main().catch(console.error);
