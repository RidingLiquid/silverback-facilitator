import { ethers } from "hardhat";
async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Wallet:", signer.address);
  const balance = await ethers.provider.getBalance(signer.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");
}
main().catch(console.error);
