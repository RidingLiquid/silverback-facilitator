import { ethers } from "hardhat";

const SPLITTER = "0x6FDf52EA446B54508f50C35612210c69Ef1C1d9a";
const NEW_TREASURY = "0x48380bCf1c09773C9E96901F89A7A6B75E2BBeCC";

async function main() {
  console.log("\n🔧 Update Fee Splitter Treasury\n");
  
  const [owner] = await ethers.getSigners();
  console.log(`Owner: ${owner.address}`);
  
  const splitter = await ethers.getContractAt("X402FeeSplitter", SPLITTER);
  
  const currentTreasury = (await splitter.getStats())[1];
  console.log(`Current treasury: ${currentTreasury}`);
  console.log(`New treasury: ${NEW_TREASURY}\n`);
  
  console.log("Updating treasury...");
  const tx = await splitter.setTreasury(NEW_TREASURY);
  await tx.wait();
  
  const newTreasury = (await splitter.getStats())[1];
  console.log(`✅ Treasury updated to: ${newTreasury}`);
}

main().catch(console.error);
