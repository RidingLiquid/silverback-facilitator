/**
 * Manage X402FeeSplitter Contract
 *
 * Usage (run from /tmp/silverback-facilitator):
 *   node scripts/manage-fee-splitter.mjs status
 *   DEPLOYER_PRIVATE_KEY=0x... node scripts/manage-fee-splitter.mjs add-facilitator 0x...
 *   DEPLOYER_PRIVATE_KEY=0x... node scripts/manage-fee-splitter.mjs remove-facilitator 0x...
 */

import { createPublicClient, createWalletClient, http, getAddress } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const FEE_SPLITTER = '0x6FDf52EA446B54508f50C35612210c69Ef1C1d9a';

const ABI = [
  { name: 'setFacilitator', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'facilitator', type: 'address' }, { name: 'authorized', type: 'bool' }], outputs: [] },
  { name: 'setTreasury', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: '_treasury', type: 'address' }], outputs: [] },
  { name: 'isFacilitator', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'facilitator', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'owner', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'treasury', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'paused', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { name: 'facilitatorCount', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'totalSettlements', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'defaultFeeBps', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'emergencyWithdraw', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
];

const rpcUrl = process.env.BASE_RPC_URL || 'https://base.publicnode.com';
const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

const read = (fn, args) => publicClient.readContract({ address: FEE_SPLITTER, abi: ABI, functionName: fn, args });

async function status() {
  console.log('\n=== X402FeeSplitter Status ===\n');
  console.log(`Contract: ${FEE_SPLITTER}`);

  const owner = await read('owner');
  const treasury = await read('treasury');
  const paused = await read('paused');
  const facCount = await read('facilitatorCount');
  const settlements = await read('totalSettlements');
  const defaultFee = await read('defaultFeeBps');

  console.log(`Owner: ${owner}`);
  console.log(`Treasury: ${treasury}`);
  console.log(`Default Fee: ${defaultFee} bps (${Number(defaultFee) / 100}%)`);
  console.log(`Facilitators: ${facCount}`);
  console.log(`Total Settlements: ${settlements}`);
  console.log(`Paused: ${paused}`);

  const wallets = [
    { label: 'New facilitator (0x4838...)', address: '0x48380bCf1c09773C9E96901F89A7A6B75E2BBeCC' },
    { label: 'Old facilitator BURNED (0x21fd...)', address: '0x21fdEd74C901129977B8e28C2588595163E1e235' },
  ];

  console.log('\nFacilitator Whitelist:');
  for (const w of wallets) {
    const isAuth = await read('isFacilitator', [w.address]);
    console.log(`  ${w.label}: ${isAuth ? '✅ authorized' : '❌ NOT authorized'}`);
  }
}

async function getWalletClient() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) { console.error('❌ DEPLOYER_PRIVATE_KEY not set'); process.exit(1); }
  const account = privateKeyToAccount(pk);
  console.log(`Signer: ${account.address}`);
  return createWalletClient({ account, chain: base, transport: http(rpcUrl) });
}

async function main() {
  const [,, command, arg] = process.argv;

  if (command === 'status' || !command) {
    await status();
    return;
  }

  const walletClient = await getWalletClient();

  if (command === 'add-facilitator') {
    const addr = getAddress(arg);
    const isAlready = await read('isFacilitator', [addr]);
    if (isAlready) { console.log(`${addr} is already authorized.`); return; }

    console.log(`Adding facilitator: ${addr}`);
    const hash = await walletClient.writeContract({
      address: FEE_SPLITTER, abi: ABI, functionName: 'setFacilitator', args: [addr, true],
    });
    console.log(`TX: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`✅ Confirmed in block ${receipt.blockNumber}`);

  } else if (command === 'remove-facilitator') {
    const addr = getAddress(arg);
    console.log(`Removing facilitator: ${addr}`);
    const hash = await walletClient.writeContract({
      address: FEE_SPLITTER, abi: ABI, functionName: 'setFacilitator', args: [addr, false],
    });
    console.log(`TX: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`✅ Removed in block ${receipt.blockNumber}`);

  } else if (command === 'set-treasury') {
    const addr = getAddress(arg);
    console.log(`Updating treasury to: ${addr}`);
    const hash = await walletClient.writeContract({
      address: FEE_SPLITTER, abi: ABI, functionName: 'setTreasury', args: [addr],
    });
    console.log(`TX: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`✅ Treasury updated in block ${receipt.blockNumber}`);

  } else if (command === 'emergency-withdraw') {
    const tokenAddr = arg ? getAddress(arg) : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // default USDC
    const amount = process.argv[5] ? BigInt(process.argv[5]) : null;

    // Check balance first
    const balAbi = [{ name: 'balanceOf', type: 'function', stateMutability: 'view',
      inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }];
    const bal = await publicClient.readContract({ address: tokenAddr, abi: balAbi, functionName: 'balanceOf', args: [FEE_SPLITTER] });
    console.log(`Token ${tokenAddr} balance in fee splitter: ${bal} (${Number(bal) / 1e6} if 6 decimals)`);

    const withdrawAmount = amount || bal;
    if (withdrawAmount === 0n) { console.log('Nothing to withdraw.'); return; }

    console.log(`Withdrawing ${withdrawAmount} of ${tokenAddr}...`);
    const hash = await walletClient.writeContract({
      address: FEE_SPLITTER, abi: ABI, functionName: 'emergencyWithdraw', args: [tokenAddr, withdrawAmount],
    });
    console.log(`TX: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`✅ Withdrawn in block ${receipt.blockNumber}`);

  } else {
    console.log('Usage: node scripts/manage-fee-splitter.mjs [status|add-facilitator|remove-facilitator|set-treasury|emergency-withdraw] [token-address] [amount]');
  }
}

main().catch(console.error);
