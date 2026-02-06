/**
 * Test X402FeeSplitter on Base Sepolia
 *
 * Uses WETH which exists on testnet with same address as mainnet.
 *
 * Steps:
 * 1. Deploy splitter
 * 2. Configure WETH fee (25 bps = 0.25%)
 * 3. Wrap some ETH → WETH
 * 4. Transfer WETH to splitter
 * 5. Call splitPayment
 * 6. Verify balances
 *
 * Usage: npx hardhat run scripts/test-sepolia.ts --network baseSepolia
 */

import { ethers } from "hardhat";

// WETH address (same on mainnet and testnet)
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";

// WETH ABI (deposit to wrap ETH)
const WETH_ABI = [
  "function deposit() payable",
  "function withdraw(uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address, uint256) returns (bool)",
  "function approve(address, uint256) returns (bool)",
];

async function main() {
  console.log("\n🧪 X402FeeSplitter Test on Base Sepolia\n");

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`ETH Balance: ${ethers.formatEther(balance)} ETH\n`);

  if (balance < ethers.parseEther("0.01")) {
    console.log("❌ Need at least 0.01 ETH for testing");
    console.log("   Get testnet ETH from: https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet");
    return;
  }

  // 1. Deploy splitter
  console.log("1️⃣ Deploying X402FeeSplitter...");
  const treasury = deployer.address; // Use deployer as treasury for testing
  const FeeSplitter = await ethers.getContractFactory("X402FeeSplitter");
  const splitter = await FeeSplitter.deploy(
    treasury,
    10, // 0.1% default
    deployer.address // deployer is also facilitator
  );
  await splitter.waitForDeployment();
  const splitterAddress = await splitter.getAddress();
  console.log(`   Deployed: ${splitterAddress}\n`);

  // 2. Configure WETH fee (0.25%)
  console.log("2️⃣ Configuring WETH fee (25 bps = 0.25%)...");
  await splitter.setTokenFee(WETH_ADDRESS, 25);
  const fee = await splitter.getTokenFee(WETH_ADDRESS);
  console.log(`   WETH fee: ${fee} bps\n`);

  // 3. Wrap some ETH → WETH
  console.log("3️⃣ Wrapping 0.001 ETH → WETH...");
  const weth = new ethers.Contract(WETH_ADDRESS, WETH_ABI, deployer);
  const wrapAmount = ethers.parseEther("0.001");
  const wrapTx = await weth.deposit({ value: wrapAmount });
  await wrapTx.wait();

  const wethBalance = await weth.balanceOf(deployer.address);
  console.log(`   WETH balance: ${ethers.formatEther(wethBalance)} WETH\n`);

  // 4. Transfer WETH to splitter
  console.log("4️⃣ Transferring WETH to splitter...");
  const transferTx = await weth.transfer(splitterAddress, wrapAmount);
  await transferTx.wait();

  const splitterWethBalance = await weth.balanceOf(splitterAddress);
  console.log(`   Splitter WETH: ${ethers.formatEther(splitterWethBalance)} WETH\n`);

  // 5. Call splitPayment
  console.log("5️⃣ Calling splitPayment...");
  const endpoint = ethers.Wallet.createRandom().address; // Random endpoint
  const payer = deployer.address;

  const splitTx = await splitter.splitPayment(
    WETH_ADDRESS,
    payer,
    endpoint,
    wrapAmount
  );
  const receipt = await splitTx.wait();
  console.log(`   Gas used: ${receipt?.gasUsed.toString()}\n`);

  // 6. Verify balances
  console.log("6️⃣ Verifying split...");

  // Expected: 0.001 WETH * 25 / 10000 = 0.0000025 WETH fee
  const expectedFee = (wrapAmount * 25n) / 10000n;
  const expectedNet = wrapAmount - expectedFee;

  const endpointBalance = await weth.balanceOf(endpoint);
  const treasuryBalance = await weth.balanceOf(treasury);
  const splitterFinalBalance = await weth.balanceOf(splitterAddress);

  console.log(`   Expected fee:     ${ethers.formatEther(expectedFee)} WETH`);
  console.log(`   Expected net:     ${ethers.formatEther(expectedNet)} WETH`);
  console.log(`   Endpoint balance: ${ethers.formatEther(endpointBalance)} WETH`);
  console.log(`   Treasury balance: ${ethers.formatEther(treasuryBalance)} WETH`);
  console.log(`   Splitter balance: ${ethers.formatEther(splitterFinalBalance)} WETH\n`);

  // Verify
  const success =
    endpointBalance === expectedNet &&
    treasuryBalance === expectedFee &&
    splitterFinalBalance === 0n;

  if (success) {
    console.log("✅ Test PASSED! Fee split working correctly.\n");
    console.log("Contract verified at:", splitterAddress);
    console.log("\nVerify on Basescan:");
    console.log(`npx hardhat verify --network baseSepolia ${splitterAddress} "${treasury}" "10" "${deployer.address}"`);
  } else {
    console.log("❌ Test FAILED! Balances don't match expected.\n");
  }

  // Show stats
  const stats = await splitter.getStats();
  console.log("\nContract Stats:");
  console.log(`  Total settlements: ${stats[0]}`);
  console.log(`  Treasury: ${stats[1]}`);
  console.log(`  Default fee: ${stats[2]} bps`);
}

main().catch(console.error);
