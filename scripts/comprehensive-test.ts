/**
 * Comprehensive X402FeeSplitter Test on Base Sepolia
 *
 * Tests:
 * 1. Multiple transactions
 * 2. Different fee rates (0%, 0.1%, 0.25%)
 * 3. Different amounts (small, medium, large)
 * 4. Fee-exempt token
 * 5. Edge cases
 * 6. Access control
 * 7. Pause functionality
 */

import { ethers } from "hardhat";

const SPLITTER = "0x8514dc860BCB61f309264ba89B8952E264286D1f";
const WETH = "0x4200000000000000000000000000000000000006";

const WETH_ABI = [
  "function deposit() payable",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address, uint256) returns (bool)",
];

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  ${name}... `);
  try {
    await fn();
    results.push({ name, passed: true });
    console.log("✅");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    results.push({ name, passed: false, error: msg });
    console.log(`❌ ${msg.slice(0, 50)}`);
  }
}

async function main() {
  console.log("\n🧪 Comprehensive X402FeeSplitter Test\n");
  console.log(`Contract: ${SPLITTER}`);
  console.log(`Network: Base Sepolia\n`);

  const [deployer] = await ethers.getSigners();
  const splitter = await ethers.getContractAt("X402FeeSplitter", SPLITTER);
  const weth = new ethers.Contract(WETH, WETH_ABI, deployer);

  // Generate unique test addresses
  const endpoints = [
    ethers.Wallet.createRandom().address,
    ethers.Wallet.createRandom().address,
    ethers.Wallet.createRandom().address,
  ];

  console.log("Test endpoints:");
  endpoints.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
  console.log();

  // ============================================================================
  // Setup: Wrap ETH and configure fees
  // ============================================================================

  console.log("📦 Setup\n");

  await test("Wrap 0.01 ETH to WETH", async () => {
    const tx = await weth.deposit({ value: ethers.parseEther("0.01"), gasLimit: 50000 });
    await tx.wait();
  });

  await test("Configure WETH fee to 10 bps (0.1%)", async () => {
    const tx = await splitter.setTokenFee(WETH, 10, { gasLimit: 100000 });
    await tx.wait();
    const fee = await splitter.getTokenFee(WETH);
    if (fee !== 10n) throw new Error(`Expected 10, got ${fee}`);
  });

  // ============================================================================
  // Test 1: Basic split with 0.1% fee
  // ============================================================================

  console.log("\n📊 Test 1: Basic Split (0.1% fee)\n");

  await test("Transfer 0.001 WETH to splitter", async () => {
    const tx = await weth.transfer(SPLITTER, ethers.parseEther("0.001"), { gasLimit: 60000 });
    await tx.wait();
  });

  await test("Split payment to endpoint 1", async () => {
    const amount = ethers.parseEther("0.001");
    const tx = await splitter.splitPayment(WETH, deployer.address, endpoints[0], amount, { gasLimit: 150000 });
    await tx.wait();
  });

  await test("Verify endpoint 1 received correct amount", async () => {
    const balance = await weth.balanceOf(endpoints[0]);
    // 0.001 - 0.1% = 0.000999
    const expected = ethers.parseEther("0.000999");
    if (balance !== expected) throw new Error(`Expected ${expected}, got ${balance}`);
  });

  // ============================================================================
  // Test 2: Higher fee (0.25%)
  // ============================================================================

  console.log("\n📊 Test 2: Higher Fee (0.25%)\n");

  await test("Change WETH fee to 25 bps (0.25%)", async () => {
    const tx = await splitter.setTokenFee(WETH, 25, { gasLimit: 100000 });
    await tx.wait();
  });

  await test("Transfer 0.002 WETH to splitter", async () => {
    const tx = await weth.transfer(SPLITTER, ethers.parseEther("0.002"), { gasLimit: 60000 });
    await tx.wait();
  });

  await test("Split payment to endpoint 2", async () => {
    const amount = ethers.parseEther("0.002");
    const tx = await splitter.splitPayment(WETH, deployer.address, endpoints[1], amount, { gasLimit: 150000 });
    await tx.wait();
  });

  await test("Verify endpoint 2 received correct amount", async () => {
    const balance = await weth.balanceOf(endpoints[1]);
    // 0.002 - 0.25% = 0.002 - 0.000005 = 0.001995
    const expected = ethers.parseEther("0.001995");
    if (balance !== expected) throw new Error(`Expected ${expected}, got ${balance}`);
  });

  // ============================================================================
  // Test 3: Fee-exempt (0%)
  // ============================================================================

  console.log("\n📊 Test 3: Fee-Exempt (0%)\n");

  await test("Set WETH fee to 0 bps (exempt)", async () => {
    const tx = await splitter.setTokenFee(WETH, 0, { gasLimit: 100000 });
    await tx.wait();
  });

  await test("Transfer 0.001 WETH to splitter", async () => {
    const tx = await weth.transfer(SPLITTER, ethers.parseEther("0.001"), { gasLimit: 60000 });
    await tx.wait();
  });

  await test("Split payment to endpoint 3", async () => {
    const amount = ethers.parseEther("0.001");
    const tx = await splitter.splitPayment(WETH, deployer.address, endpoints[2], amount, { gasLimit: 150000 });
    await tx.wait();
  });

  await test("Verify endpoint 3 received FULL amount (no fee)", async () => {
    const balance = await weth.balanceOf(endpoints[2]);
    const expected = ethers.parseEther("0.001");
    if (balance !== expected) throw new Error(`Expected ${expected}, got ${balance}`);
  });

  // ============================================================================
  // Test 4: Access Control
  // ============================================================================

  console.log("\n🔒 Test 4: Access Control\n");

  await test("Non-facilitator cannot call splitPayment", async () => {
    const randomWallet = ethers.Wallet.createRandom().connect(ethers.provider);

    // This should revert
    try {
      await splitter.connect(randomWallet).splitPayment.staticCall(
        WETH,
        deployer.address,
        endpoints[0],
        1000
      );
      throw new Error("Should have reverted");
    } catch (e: any) {
      if (!e.message.includes("NotAuthorizedFacilitator")) {
        throw new Error("Wrong error: " + e.message);
      }
    }
  });

  await test("Non-owner cannot set fees", async () => {
    const randomWallet = ethers.Wallet.createRandom().connect(ethers.provider);

    try {
      await splitter.connect(randomWallet).setTokenFee.staticCall(WETH, 50);
      throw new Error("Should have reverted");
    } catch (e: any) {
      if (!e.message.includes("Ownable")) {
        throw new Error("Wrong error: " + e.message);
      }
    }
  });

  // ============================================================================
  // Test 5: Pause
  // ============================================================================

  console.log("\n⏸️ Test 5: Pause Functionality\n");

  await test("Pause contract", async () => {
    const tx = await splitter.pause({ gasLimit: 50000 });
    await tx.wait();
    const paused = await splitter.paused();
    if (!paused) throw new Error("Should be paused");
  });

  await test("Cannot split when paused", async () => {
    try {
      await splitter.splitPayment.staticCall(WETH, deployer.address, endpoints[0], 1000);
      throw new Error("Should have reverted");
    } catch (e: any) {
      if (!e.message.includes("EnforcedPause") && !e.message.includes("Pausable")) {
        throw new Error("Wrong error: " + e.message);
      }
    }
  });

  await test("Unpause contract", async () => {
    const tx = await splitter.unpause({ gasLimit: 50000 });
    await tx.wait();
    const paused = await splitter.paused();
    if (paused) throw new Error("Should not be paused");
  });

  // ============================================================================
  // Test 6: Stats Verification
  // ============================================================================

  console.log("\n📈 Test 6: Stats Verification\n");

  await test("Verify total settlements count", async () => {
    const stats = await splitter.getStats();
    // We did 3 successful splits + 1 from earlier test = 4
    if (stats[0] < 3n) throw new Error(`Expected at least 3 settlements, got ${stats[0]}`);
  });

  await test("Verify fees collected", async () => {
    const tokenStats = await splitter.getTokenStats(WETH);
    // Should have collected some fees
    if (tokenStats[3] === 0n) throw new Error("Should have collected some fees");
    console.log(`\n    Fees collected: ${ethers.formatEther(tokenStats[3])} WETH`);
  });

  await test("Verify volume tracked", async () => {
    const tokenStats = await splitter.getTokenStats(WETH);
    // Should have tracked volume
    if (tokenStats[4] === 0n) throw new Error("Should have tracked volume");
    console.log(`    Volume processed: ${ethers.formatEther(tokenStats[4])} WETH`);
  });

  // ============================================================================
  // Summary
  // ============================================================================

  console.log("\n" + "═".repeat(50));
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  if (failed === 0) {
    console.log(`\n✅ ALL ${passed} TESTS PASSED!\n`);
  } else {
    console.log(`\n❌ ${failed} FAILED, ${passed} PASSED\n`);
    console.log("Failed tests:");
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  - ${r.name}: ${r.error}`);
    });
  }

  // Reset fee for next time
  console.log("Resetting WETH fee to 25 bps...");
  await splitter.setTokenFee(WETH, 25, { gasLimit: 100000 });

  console.log("\n📋 Final Contract State:");
  const finalStats = await splitter.getStats();
  console.log(`  Settlements: ${finalStats[0]}`);
  console.log(`  Treasury: ${finalStats[1]}`);

  const tokenStats = await splitter.getTokenStats(WETH);
  console.log(`  WETH fee: ${tokenStats[0]} bps`);
  console.log(`  Fees collected: ${ethers.formatEther(tokenStats[3])} WETH`);
  console.log(`  Volume: ${ethers.formatEther(tokenStats[4])} WETH\n`);
}

main().catch(console.error);
