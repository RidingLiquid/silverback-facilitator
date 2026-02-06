import { ethers } from "hardhat";

const SPLITTER = "0x8514dc860BCB61f309264ba89B8952E264286D1f";
const WETH = "0x4200000000000000000000000000000000000006";
const ENDPOINT = "0x0000000000000000000000000000000000000001";

async function main() {
  const splitter = await ethers.getContractAt("X402FeeSplitter", SPLITTER);

  console.log("\n📊 Contract State:\n");

  // Get stats
  const stats = await splitter.getStats();
  console.log(`Settlements: ${stats[0]}`);
  console.log(`Treasury: ${stats[1]}`);
  console.log(`Default fee: ${stats[2]} bps`);
  console.log(`Facilitators: ${stats[3]}`);
  console.log(`Paused: ${stats[4]}`);

  // Token stats
  const tokenStats = await splitter.getTokenStats(WETH);
  console.log(`\nWETH Stats:`);
  console.log(`  Fee: ${tokenStats[0]} bps`);
  console.log(`  Configured: ${tokenStats[1]}`);
  console.log(`  Fees collected: ${ethers.formatEther(tokenStats[3])} WETH`);
  console.log(`  Volume: ${ethers.formatEther(tokenStats[4])} WETH`);

  // Check balances
  const weth = new ethers.Contract(WETH, ["function balanceOf(address) view returns (uint256)"], ethers.provider);

  const splitterBal = await weth.balanceOf(SPLITTER);
  const endpointBal = await weth.balanceOf(ENDPOINT);
  const treasuryBal = await weth.balanceOf(stats[1]);

  console.log(`\nBalances:`);
  console.log(`  Splitter: ${ethers.formatEther(splitterBal)} WETH`);
  console.log(`  Endpoint: ${ethers.formatEther(endpointBal)} WETH`);
  console.log(`  Treasury: ${ethers.formatEther(treasuryBal)} WETH`);
}

main().catch(console.error);
