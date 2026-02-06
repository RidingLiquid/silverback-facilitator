/**
 * Deploy X402FeeSplitter to Base
 *
 * Usage:
 *   npx hardhat run scripts/deploy.ts --network base
 *   npx hardhat run scripts/deploy.ts --network baseSepolia
 */

import { ethers, network } from "hardhat";

// Token addresses on Base mainnet
const TOKENS = {
  BACK: "0x558881c4959e9cf961a7E1815FCD6586906babd2",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  USDT: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
  DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  USDbC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
  VIRTUAL: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
  WETH: "0x4200000000000000000000000000000000000006",
  cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
};

// Fee basis points
const FEES: Record<string, number> = {
  BACK: 0, // Fee-exempt
  USDC: 10, // 0.1%
  USDT: 10,
  DAI: 10,
  USDbC: 10,
  VIRTUAL: 10,
  WETH: 25, // 0.25%
  cbBTC: 25,
};

async function main() {
  console.log("\n🚀 X402FeeSplitter Deployment\n");
  console.log(`Network: ${network.name}`);

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH\n`);

  // Configuration
  const treasury = "0xD34411a70EffbDd000c529bbF572082ffDcF1794";
  const defaultFeeBps = 10; // 0.1%
  const facilitator = "0x21fdEd74C901129977B8e28C2588595163E1e235";

  console.log("Configuration:");
  console.log(`  Treasury: ${treasury}`);
  console.log(`  Default Fee: ${defaultFeeBps} bps (${defaultFeeBps / 100}%)`);
  console.log(`  Initial Facilitator: ${facilitator}\n`);

  // Deploy
  console.log("Deploying X402FeeSplitter...");
  const FeeSplitter = await ethers.getContractFactory("X402FeeSplitter");
  const splitter = await FeeSplitter.deploy(
    treasury,
    defaultFeeBps,
    facilitator
  );

  await splitter.waitForDeployment();
  const address = await splitter.getAddress();
  console.log(`✅ Deployed to: ${address}\n`);

  // Configure token fees
  console.log("Configuring token fees...");
  const tokens = Object.values(TOKENS);
  const fees = Object.keys(TOKENS).map((symbol) => FEES[symbol]);

  const tx = await splitter.setTokenFeesBatch(tokens, fees);
  await tx.wait();

  console.log("Token fees configured:");
  for (const [symbol, fee] of Object.entries(FEES)) {
    const percent = fee / 100;
    const status = fee === 0 ? "(exempt)" : "";
    console.log(`  ${symbol.padEnd(8)} ${fee} bps = ${percent}% ${status}`);
  }

  // Verification command
  console.log("\n📋 Verification Command:");
  console.log(`npx hardhat verify --network ${network.name} ${address} \\`);
  console.log(`  "${treasury}" \\`);
  console.log(`  "${defaultFeeBps}" \\`);
  console.log(`  "${facilitator}"`);

  // Summary
  console.log("\n✅ Deployment Complete!\n");
  console.log("Next Steps:");
  console.log("1. Verify contract on Basescan");
  console.log("2. Update facilitator .env with X402_FEE_SPLITTER_ADDRESS");
  console.log("3. Update x402 server to use splitter as payTo");
  console.log("4. Enable X402_FEE_SPLITTER_ENABLED=true");

  return address;
}

main()
  .then((address) => {
    console.log(`\nContract Address: ${address}`);
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
