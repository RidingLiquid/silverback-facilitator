/**
 * Continue test with already-deployed contract
 */
import { ethers } from "hardhat";

const SPLITTER_ADDRESS = "0x8514dc860BCB61f309264ba89B8952E264286D1f";
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";

const WETH_ABI = [
  "function deposit() payable",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address, uint256) returns (bool)",
];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`\n🧪 Continuing test with deployed contract\n`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Splitter: ${SPLITTER_ADDRESS}\n`);

  const splitter = await ethers.getContractAt("X402FeeSplitter", SPLITTER_ADDRESS);
  const weth = new ethers.Contract(WETH_ADDRESS, WETH_ABI, deployer);

  // Check current config
  const currentFee = await splitter.getTokenFee(WETH_ADDRESS);
  console.log(`Current WETH fee: ${currentFee} bps`);

  if (currentFee !== 25n) {
    console.log("Setting WETH fee to 25 bps...");
    const tx = await splitter.setTokenFee(WETH_ADDRESS, 25, { gasLimit: 100000 });
    await tx.wait();
    console.log("Fee set!");
  }

  // Wrap ETH
  console.log("\nWrapping 0.001 ETH → WETH...");
  const wrapAmount = ethers.parseEther("0.001");
  const wrapTx = await weth.deposit({ value: wrapAmount, gasLimit: 50000 });
  await wrapTx.wait();

  const wethBalance = await weth.balanceOf(deployer.address);
  console.log(`WETH balance: ${ethers.formatEther(wethBalance)} WETH`);

  // Transfer to splitter
  console.log("\nTransferring to splitter...");
  const transferTx = await weth.transfer(SPLITTER_ADDRESS, wrapAmount, { gasLimit: 60000 });
  await transferTx.wait();

  // Split payment
  console.log("\nCalling splitPayment...");
  const endpoint = "0x0000000000000000000000000000000000000001"; // Test address
  const splitTx = await splitter.splitPayment(
    WETH_ADDRESS,
    deployer.address,
    endpoint,
    wrapAmount,
    { gasLimit: 150000 }
  );
  const receipt = await splitTx.wait();
  console.log(`Gas used: ${receipt?.gasUsed}`);

  // Check results
  const expectedFee = (wrapAmount * 25n) / 10000n;
  const expectedNet = wrapAmount - expectedFee;

  const endpointBalance = await weth.balanceOf(endpoint);
  const treasuryBalance = await weth.balanceOf(deployer.address); // deployer is treasury in this test

  console.log(`\n📊 Results:`);
  console.log(`Expected fee: ${ethers.formatEther(expectedFee)} WETH`);
  console.log(`Expected net: ${ethers.formatEther(expectedNet)} WETH`);
  console.log(`Endpoint got: ${ethers.formatEther(endpointBalance)} WETH`);

  if (endpointBalance === expectedNet) {
    console.log("\n✅ TEST PASSED! Fee split working correctly.\n");
  } else {
    console.log("\n❌ Amounts don't match expected\n");
  }

  // Stats
  const stats = await splitter.getStats();
  console.log(`Total settlements: ${stats[0]}`);
}

main().catch(console.error);
