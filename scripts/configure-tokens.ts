/**
 * Configure all supported tokens with their fee rates on X402FeeSplitter
 *
 * Fee Structure:
 * - BACK: 0 bps (fee-exempt)
 * - Stablecoins (USDC, USDT, DAI, USDbC): 10 bps (0.1%)
 * - Volatile (VIRTUAL): 10 bps (0.1%)
 * - Blue-chips (WETH, cbBTC): 25 bps (0.25%)
 */

import { ethers } from "hardhat";

// Base Sepolia testnet deployment
const SPLITTER = "0x8514dc860BCB61f309264ba89B8952E264286D1f";

// Token addresses on Base (same on mainnet and most match testnet for WETH)
const TOKENS = {
  // Fee-exempt (0 bps)
  BACK: "0x558881c4959e9cf961a7E1815FCD6586906babd2",

  // Stablecoins (10 bps = 0.1%)
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  USDT: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
  DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  USDbC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",

  // Volatile (10 bps = 0.1%)
  VIRTUAL: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",

  // Blue-chips (25 bps = 0.25%)
  WETH: "0x4200000000000000000000000000000000000006",
  cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
};

// Fee rates in basis points
const FEE_RATES = {
  BACK: 0,      // Fee-exempt
  USDC: 10,     // 0.1%
  USDT: 10,     // 0.1%
  DAI: 10,      // 0.1%
  USDbC: 10,    // 0.1%
  VIRTUAL: 10,  // 0.1%
  WETH: 25,     // 0.25%
  cbBTC: 25,    // 0.25%
};

async function main() {
  console.log("\n🔧 Configure X402FeeSplitter Tokens\n");
  console.log(`Contract: ${SPLITTER}`);

  const [deployer] = await ethers.getSigners();
  console.log(`Owner: ${deployer.address}\n`);

  const splitter = await ethers.getContractAt("X402FeeSplitter", SPLITTER);

  // Check current state
  console.log("📊 Current Configuration:\n");
  for (const [name, address] of Object.entries(TOKENS)) {
    const stats = await splitter.getTokenStats(address);
    const configured = stats[1] ? "✓" : "✗";
    console.log(`  ${name.padEnd(8)} ${configured} ${stats[0]} bps`);
  }

  // Prepare batch configuration
  console.log("\n📝 Configuring all tokens...\n");

  const tokenAddresses = Object.values(TOKENS);
  const tokenNames = Object.keys(TOKENS);
  const fees = tokenNames.map(name => FEE_RATES[name as keyof typeof FEE_RATES]);

  console.log("Tokens to configure:");
  tokenNames.forEach((name, i) => {
    console.log(`  ${name.padEnd(8)} → ${fees[i]} bps (${(fees[i] / 100).toFixed(2)}%)`);
  });

  // Use batch function
  console.log("\n⏳ Sending batch transaction...");
  const tx = await splitter.setTokenFeesBatch(tokenAddresses, fees, { gasLimit: 300000 });
  console.log(`  TX: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`  Confirmed in block ${receipt?.blockNumber}`);

  // Verify configuration
  console.log("\n✅ Final Configuration:\n");
  for (const [name, address] of Object.entries(TOKENS)) {
    const stats = await splitter.getTokenStats(address);
    const configured = stats[1] ? "✓" : "✗";
    const expectedFee = FEE_RATES[name as keyof typeof FEE_RATES];
    const match = Number(stats[0]) === expectedFee ? "✓" : "✗";
    console.log(`  ${name.padEnd(8)} ${configured} ${stats[0]} bps ${match}`);
  }

  // Show summary
  const globalStats = await splitter.getStats();
  console.log("\n📈 Contract Stats:");
  console.log(`  Settlements: ${globalStats[0]}`);
  console.log(`  Treasury: ${globalStats[1]}`);
  console.log(`  Default fee: ${globalStats[2]} bps`);
  console.log(`  Facilitators: ${globalStats[3]}`);
  console.log(`  Paused: ${globalStats[4]}`);
  console.log();
}

main().catch(console.error);
