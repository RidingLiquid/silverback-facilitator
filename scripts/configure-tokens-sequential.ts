/**
 * Configure all supported tokens sequentially (avoids gas issues)
 */

import { ethers } from "hardhat";

const SPLITTER = "0x8514dc860BCB61f309264ba89B8952E264286D1f";

const TOKENS: [string, string, number][] = [
  // [name, address, fee bps]
  ["BACK", "0x558881c4959e9cf961a7E1815FCD6586906babd2", 0],      // Fee-exempt
  ["USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 10],    // 0.1%
  ["USDT", "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", 10],    // 0.1%
  ["DAI", "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", 10],     // 0.1%
  ["USDbC", "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", 10],   // 0.1%
  ["VIRTUAL", "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", 10], // 0.1%
  ["WETH", "0x4200000000000000000000000000000000000006", 25],     // 0.25%
  ["cbBTC", "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", 25],   // 0.25%
];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log("\n🔧 Configure Tokens (Sequential)\n");

  const [deployer] = await ethers.getSigners();
  const splitter = await ethers.getContractAt("X402FeeSplitter", SPLITTER);

  console.log(`Contract: ${SPLITTER}`);
  console.log(`Owner: ${deployer.address}\n`);

  for (const [name, address, fee] of TOKENS) {
    const stats = await splitter.getTokenStats(address);
    const currentFee = Number(stats[0]);
    const configured = stats[1];

    if (configured && currentFee === fee) {
      console.log(`${name.padEnd(8)} ✓ Already configured at ${fee} bps`);
      continue;
    }

    process.stdout.write(`${name.padEnd(8)} Setting to ${fee} bps... `);

    try {
      const tx = await splitter.setTokenFee(address, fee, { gasLimit: 100000 });
      await tx.wait();
      console.log(`✅ ${tx.hash.slice(0, 10)}...`);
      await sleep(1500);
    } catch (e: any) {
      console.log(`❌ ${e.message.slice(0, 50)}`);
    }
  }

  // Final summary
  console.log("\n📊 Final Configuration:\n");
  for (const [name, address, expectedFee] of TOKENS) {
    const stats = await splitter.getTokenStats(address);
    const fee = Number(stats[0]);
    const match = fee === expectedFee ? "✓" : "✗";
    console.log(`  ${name.padEnd(8)} ${fee.toString().padStart(2)} bps ${match}`);
  }

  console.log("\n✅ Done!\n");
}

main().catch(console.error);
