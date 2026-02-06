/**
 * E2E Test: Fee Splitter Integration
 *
 * Tests the full flow:
 * 1. Transfer tokens to fee splitter (simulating Permit2)
 * 2. Call splitPayment() to distribute
 * 3. Verify endpoint receives net amount
 * 4. Verify treasury receives fee
 *
 * Usage:
 *   npx hardhat run scripts/test-fee-splitter-e2e.ts --network baseSepolia
 */

import { ethers } from "hardhat";

const SPLITTER = "0x8514dc860BCB61f309264ba89B8952E264286D1f";
const WETH = "0x4200000000000000000000000000000000000006";

const WETH_ABI = [
  "function deposit() payable",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address, uint256) returns (bool)",
];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log("\n🧪 E2E Test: Fee Splitter Integration\n");
  console.log("═".repeat(60));

  const [deployer] = await ethers.getSigners();
  const splitter = await ethers.getContractAt("X402FeeSplitter", SPLITTER);
  const weth = new ethers.Contract(WETH, WETH_ABI, deployer);

  // Random endpoint address (simulates an x402 endpoint)
  const endpoint = ethers.Wallet.createRandom().address;
  const payer = deployer.address; // Simulates the client who paid

  console.log(`\n📋 Setup:`);
  console.log(`   Splitter: ${SPLITTER}`);
  console.log(`   Payer: ${payer}`);
  console.log(`   Endpoint: ${endpoint}`);

  // Get initial state
  const stats = await splitter.getStats();
  const treasury = stats[1];
  const tokenStats = await splitter.getTokenStats(WETH);
  const feeBps = Number(tokenStats[0]);

  console.log(`   Treasury: ${treasury}`);
  console.log(`   WETH Fee: ${feeBps} bps (${(feeBps / 100).toFixed(2)}%)`);

  // Get initial balances
  const treasuryBalBefore = await weth.balanceOf(treasury);
  const endpointBalBefore = await weth.balanceOf(endpoint);

  console.log(`\n📊 Initial Balances:`);
  console.log(`   Endpoint: ${ethers.formatEther(endpointBalBefore)} WETH`);
  console.log(`   Treasury: ${ethers.formatEther(treasuryBalBefore)} WETH`);

  // Test amount
  const amount = ethers.parseEther("0.001");
  const expectedFee = (amount * BigInt(feeBps)) / 10000n;
  const expectedNet = amount - expectedFee;

  console.log(`\n🔄 Test: Split ${ethers.formatEther(amount)} WETH`);
  console.log(`   Expected fee: ${ethers.formatEther(expectedFee)} WETH`);
  console.log(`   Expected net: ${ethers.formatEther(expectedNet)} WETH`);

  // Step 1: Wrap ETH to WETH
  console.log(`\n   Step 1: Wrap ${ethers.formatEther(amount)} ETH to WETH...`);
  let tx = await weth.deposit({ value: amount });
  await tx.wait();
  await sleep(1500);

  // Step 2: Transfer to splitter (simulates Permit2 transfer)
  console.log(`   Step 2: Transfer WETH to splitter (simulates Permit2)...`);
  tx = await weth.transfer(SPLITTER, amount);
  await tx.wait();
  await sleep(1500);

  // Step 3: Call splitPayment
  console.log(`   Step 3: Call splitPayment()...`);
  tx = await splitter.splitPayment(WETH, payer, endpoint, amount, { gasLimit: 150000 });
  const receipt = await tx.wait();
  console.log(`   TX: ${tx.hash}`);
  console.log(`   Block: ${receipt?.blockNumber}`);
  await sleep(1500);

  // Step 4: Verify balances
  const endpointBalAfter = await weth.balanceOf(endpoint);
  const treasuryBalAfter = await weth.balanceOf(treasury);

  const endpointReceived = endpointBalAfter - endpointBalBefore;
  const treasuryReceived = treasuryBalAfter - treasuryBalBefore;

  console.log(`\n📊 Final Balances:`);
  console.log(`   Endpoint: ${ethers.formatEther(endpointBalAfter)} WETH (+${ethers.formatEther(endpointReceived)})`);
  console.log(`   Treasury: ${ethers.formatEther(treasuryBalAfter)} WETH (+${ethers.formatEther(treasuryReceived)})`);

  // Verify
  console.log(`\n✅ Verification:`);

  const endpointOk = endpointReceived === expectedNet;
  const treasuryOk = treasuryReceived === expectedFee;

  console.log(`   Endpoint received correct amount: ${endpointOk ? "✓" : "✗"}`);
  console.log(`     Expected: ${ethers.formatEther(expectedNet)}`);
  console.log(`     Actual:   ${ethers.formatEther(endpointReceived)}`);

  console.log(`   Treasury received correct fee: ${treasuryOk ? "✓" : "✗"}`);
  console.log(`     Expected: ${ethers.formatEther(expectedFee)}`);
  console.log(`     Actual:   ${ethers.formatEther(treasuryReceived)}`);

  // Final stats
  const statsAfter = await splitter.getStats();
  const tokenStatsAfter = await splitter.getTokenStats(WETH);

  console.log(`\n📈 Contract Stats After:`);
  console.log(`   Total settlements: ${statsAfter[0]}`);
  console.log(`   WETH fees collected: ${ethers.formatEther(tokenStatsAfter[3])} WETH`);
  console.log(`   WETH volume: ${ethers.formatEther(tokenStatsAfter[4])} WETH`);

  console.log("\n" + "═".repeat(60));
  if (endpointOk && treasuryOk) {
    console.log("✅ E2E TEST PASSED!");
  } else {
    console.log("❌ E2E TEST FAILED!");
  }
  console.log("═".repeat(60) + "\n");
}

main().catch(console.error);
