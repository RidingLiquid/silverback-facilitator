/**
 * Authorize a facilitator wallet on the X402FeeSplitter contract
 *
 * The facilitator must be authorized to call splitPayment()
 *
 * Usage:
 *   npx hardhat run scripts/authorize-facilitator.ts --network baseSepolia
 *   npx hardhat run scripts/authorize-facilitator.ts --network base
 */

import { ethers } from "hardhat";

// Contract addresses
const SPLITTER_TESTNET = "0x8514dc860BCB61f309264ba89B8952E264286D1f";
const SPLITTER_MAINNET = ""; // TODO: Set after mainnet deployment

async function main() {
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  console.log("\n🔐 Authorize Facilitator on X402FeeSplitter\n");
  console.log(`Network: ${chainId === 84532 ? "Base Sepolia" : "Base Mainnet"}`);
  console.log(`Chain ID: ${chainId}\n`);

  // Get splitter address for this network
  const splitterAddress = chainId === 84532 ? SPLITTER_TESTNET : SPLITTER_MAINNET;
  if (!splitterAddress) {
    console.error("❌ Fee splitter not deployed on this network");
    return;
  }

  const [deployer] = await ethers.getSigners();
  console.log(`Owner wallet: ${deployer.address}`);

  const splitter = await ethers.getContractAt("X402FeeSplitter", splitterAddress);

  // Get current facilitator count
  const statsBefore = await splitter.getStats();
  console.log(`\nCurrent facilitator count: ${statsBefore[3]}`);

  // The facilitator wallet to authorize
  // In production, this should be the server wallet that calls splitPayment()
  // For testnet, we use the same wallet that deployed the contract
  const facilitatorAddress = process.env.FACILITATOR_ADDRESS || deployer.address;

  console.log(`\nFacilitator to authorize: ${facilitatorAddress}`);

  // Check if already authorized
  const isAuthorized = await splitter.isFacilitator(facilitatorAddress);
  if (isAuthorized) {
    console.log("✅ Already authorized!");
    return;
  }

  // Authorize the facilitator
  console.log("\n⏳ Authorizing...");
  const tx = await splitter.setFacilitator(facilitatorAddress, true, { gasLimit: 100000 });
  console.log(`   TX: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`   Confirmed in block ${receipt?.blockNumber}`);

  // Verify authorization
  const isNowAuthorized = await splitter.isFacilitator(facilitatorAddress);
  const statsAfter = await splitter.getStats();

  if (isNowAuthorized) {
    console.log("\n✅ Facilitator authorized successfully!");
    console.log(`   Facilitator count: ${statsAfter[3]}`);
  } else {
    console.log("\n❌ Authorization failed!");
  }
}

main().catch(console.error);
