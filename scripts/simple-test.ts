/**
 * Simple sequential test with delays to avoid nonce issues
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
  console.log("\n🧪 Simple Sequential Test\n");

  const [deployer] = await ethers.getSigners();
  const splitter = await ethers.getContractAt("X402FeeSplitter", SPLITTER);
  const weth = new ethers.Contract(WETH, WETH_ABI, deployer);

  // Get starting state
  const startStats = await splitter.getStats();
  const startTokenStats = await splitter.getTokenStats(WETH);
  console.log(`Starting settlements: ${startStats[0]}`);
  console.log(`Starting volume: ${ethers.formatEther(startTokenStats[4])} WETH\n`);

  // Test 1: 0.25% fee
  console.log("Test 1: Split 0.001 WETH with 25 bps fee (0.25%)");
  const endpoint1 = ethers.Wallet.createRandom().address;
  const amount1 = ethers.parseEther("0.001");

  console.log("  Setting fee to 25 bps...");
  let tx = await splitter.setTokenFee(WETH, 25);
  await tx.wait();
  await sleep(2000);

  console.log("  Wrapping 0.001 ETH...");
  tx = await weth.deposit({ value: amount1 });
  await tx.wait();
  await sleep(2000);

  console.log("  Transferring to splitter...");
  tx = await weth.transfer(SPLITTER, amount1);
  await tx.wait();
  await sleep(2000);

  console.log("  Splitting...");
  tx = await splitter.splitPayment(WETH, deployer.address, endpoint1, amount1);
  await tx.wait();
  await sleep(2000);

  const bal1 = await weth.balanceOf(endpoint1);
  const expected1 = amount1 - (amount1 * 25n / 10000n);
  console.log(`  Endpoint received: ${ethers.formatEther(bal1)} WETH`);
  console.log(`  Expected:          ${ethers.formatEther(expected1)} WETH`);
  console.log(`  ${bal1 === expected1 ? "✅ PASS" : "❌ FAIL"}\n`);

  // Test 2: 0% fee (exempt)
  console.log("Test 2: Split 0.001 WETH with 0 bps fee (exempt)");
  const endpoint2 = ethers.Wallet.createRandom().address;
  const amount2 = ethers.parseEther("0.001");

  console.log("  Setting fee to 0 bps (exempt)...");
  tx = await splitter.setTokenFee(WETH, 0);
  await tx.wait();
  await sleep(2000);

  console.log("  Wrapping 0.001 ETH...");
  tx = await weth.deposit({ value: amount2 });
  await tx.wait();
  await sleep(2000);

  console.log("  Transferring to splitter...");
  tx = await weth.transfer(SPLITTER, amount2);
  await tx.wait();
  await sleep(2000);

  console.log("  Splitting...");
  tx = await splitter.splitPayment(WETH, deployer.address, endpoint2, amount2);
  await tx.wait();
  await sleep(2000);

  const bal2 = await weth.balanceOf(endpoint2);
  console.log(`  Endpoint received: ${ethers.formatEther(bal2)} WETH`);
  console.log(`  Expected:          ${ethers.formatEther(amount2)} WETH (full amount)`);
  console.log(`  ${bal2 === amount2 ? "✅ PASS" : "❌ FAIL"}\n`);

  // Test 3: 0.1% fee
  console.log("Test 3: Split 0.002 WETH with 10 bps fee (0.1%)");
  const endpoint3 = ethers.Wallet.createRandom().address;
  const amount3 = ethers.parseEther("0.002");

  console.log("  Setting fee to 10 bps...");
  tx = await splitter.setTokenFee(WETH, 10);
  await tx.wait();
  await sleep(2000);

  console.log("  Wrapping 0.002 ETH...");
  tx = await weth.deposit({ value: amount3 });
  await tx.wait();
  await sleep(2000);

  console.log("  Transferring to splitter...");
  tx = await weth.transfer(SPLITTER, amount3);
  await tx.wait();
  await sleep(2000);

  console.log("  Splitting...");
  tx = await splitter.splitPayment(WETH, deployer.address, endpoint3, amount3);
  await tx.wait();
  await sleep(2000);

  const bal3 = await weth.balanceOf(endpoint3);
  const expected3 = amount3 - (amount3 * 10n / 10000n);
  console.log(`  Endpoint received: ${ethers.formatEther(bal3)} WETH`);
  console.log(`  Expected:          ${ethers.formatEther(expected3)} WETH`);
  console.log(`  ${bal3 === expected3 ? "✅ PASS" : "❌ FAIL"}\n`);

  // Final stats
  const endStats = await splitter.getStats();
  const endTokenStats = await splitter.getTokenStats(WETH);

  console.log("═".repeat(50));
  console.log("\n📊 Final State:");
  console.log(`  Total settlements: ${endStats[0]} (+${endStats[0] - startStats[0]} new)`);
  console.log(`  Volume: ${ethers.formatEther(endTokenStats[4])} WETH`);
  console.log(`  Fees collected: ${ethers.formatEther(endTokenStats[3])} WETH`);

  // Reset to 25 bps
  tx = await splitter.setTokenFee(WETH, 25);
  await tx.wait();
  console.log("\n  Reset fee to 25 bps");
}

main().catch(console.error);
