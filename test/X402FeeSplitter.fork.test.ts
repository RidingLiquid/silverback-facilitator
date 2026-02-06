/**
 * Fork Tests for X402FeeSplitter
 *
 * These tests run against a fork of Base mainnet, using real token addresses.
 * This verifies the contract works with actual token implementations.
 *
 * Run: npx hardhat test test/X402FeeSplitter.fork.test.ts --network hardhat
 */

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { X402FeeSplitter } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

// Real Base mainnet token addresses
const TOKENS = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  BACK: "0x558881c4959e9cf961a7E1815FCD6586906babd2",
  USDT: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
  DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  USDbC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
  VIRTUAL: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
  WETH: "0x4200000000000000000000000000000000000006",
  cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
};

// Token decimals
const DECIMALS: Record<string, number> = {
  USDC: 6,
  BACK: 18,
  USDT: 6,
  DAI: 18,
  USDbC: 6,
  VIRTUAL: 18,
  WETH: 18,
  cbBTC: 8,
};

// Token fees (basis points)
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

// ERC20 ABI for interacting with real tokens
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address, uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

describe("X402FeeSplitter - Base Mainnet Fork", function () {
  let splitter: X402FeeSplitter;
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let facilitator: SignerWithAddress;
  let endpoint: SignerWithAddress;

  // Whale addresses with token balances (for impersonation)
  const USDC_WHALE = "0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A"; // Known USDC holder on Base

  before(async function () {
    // Skip if not running on fork or if fork fails
    if (network.name !== "hardhat") {
      console.log("  Skipping fork tests (not on hardhat network)");
      this.skip();
    }

    try {
      // Fork Base mainnet (latest block - no archive node needed)
      await network.provider.request({
        method: "hardhat_reset",
        params: [
          {
            forking: {
              jsonRpcUrl: process.env.BASE_RPC_URL || "https://base.publicnode.com",
              // Use latest block (no blockNumber = latest)
            },
          },
        ],
      });
    } catch (error) {
      console.log("  Skipping fork tests (RPC fork failed - need archive node)");
      this.skip();
    }
  });

  beforeEach(async function () {
    [owner, treasury, facilitator, endpoint] = await ethers.getSigners();

    // Deploy splitter
    const FeeSplitter = await ethers.getContractFactory("X402FeeSplitter");
    splitter = await FeeSplitter.deploy(
      treasury.address,
      10, // 0.1% default
      facilitator.address
    );

    // Configure all token fees
    const tokens = Object.entries(TOKENS).map(([_, addr]) => addr);
    const fees = Object.keys(TOKENS).map((symbol) => FEES[symbol]);
    await splitter.setTokenFeesBatch(tokens, fees);
  });

  describe("Real Token Integration", function () {
    it("should correctly configure all token fees", async function () {
      for (const [symbol, address] of Object.entries(TOKENS)) {
        const fee = await splitter.getTokenFee(address);
        expect(fee).to.equal(FEES[symbol], `${symbol} fee mismatch`);
      }
    });

    it("should process USDC payment with correct fee", async function () {
      // Impersonate whale
      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [USDC_WHALE],
      });

      const whale = await ethers.getSigner(USDC_WHALE);

      // Fund whale with ETH for gas
      await owner.sendTransaction({
        to: USDC_WHALE,
        value: ethers.parseEther("1"),
      });

      const usdc = new ethers.Contract(TOKENS.USDC, ERC20_ABI, whale);
      const amount = ethers.parseUnits("100", 6); // 100 USDC

      // Transfer USDC to splitter
      await usdc.transfer(await splitter.getAddress(), amount);

      // Split payment
      await splitter
        .connect(facilitator)
        .splitPayment(TOKENS.USDC, whale.address, endpoint.address, amount);

      // Verify split (0.1% fee = 0.10 USDC)
      const expectedFee = ethers.parseUnits("0.1", 6);
      const expectedNet = amount - expectedFee;

      expect(await usdc.balanceOf(endpoint.address)).to.equal(expectedNet);
      expect(await usdc.balanceOf(treasury.address)).to.equal(expectedFee);

      await network.provider.request({
        method: "hardhat_stopImpersonatingAccount",
        params: [USDC_WHALE],
      });
    });
  });

  describe("Fee Calculations", function () {
    it("should calculate correct split for all tokens", async function () {
      for (const [symbol, address] of Object.entries(TOKENS)) {
        const decimals = DECIMALS[symbol];
        const amount = ethers.parseUnits("1000", decimals); // 1000 tokens

        const [net, fee] = await splitter.calculateSplit(address, amount);

        const expectedFee = (amount * BigInt(FEES[symbol])) / 10000n;
        const expectedNet = amount - expectedFee;

        expect(fee).to.equal(expectedFee, `${symbol} fee calculation`);
        expect(net).to.equal(expectedNet, `${symbol} net calculation`);
      }
    });

    it("should show BACK as fee-exempt", async function () {
      const amount = ethers.parseEther("1000"); // 1000 BACK
      const [net, fee] = await splitter.calculateSplit(TOKENS.BACK, amount);

      expect(fee).to.equal(0);
      expect(net).to.equal(amount);
    });

    it("should show WETH with higher fee (0.25%)", async function () {
      const amount = ethers.parseEther("10"); // 10 WETH
      const [net, fee] = await splitter.calculateSplit(TOKENS.WETH, amount);

      // 0.25% of 10 ETH = 0.025 ETH
      expect(fee).to.equal(ethers.parseEther("0.025"));
      expect(net).to.equal(ethers.parseEther("9.975"));
    });
  });

  describe("Gas Usage", function () {
    it("should report gas for splitPayment", async function () {
      // Deploy mock for this test
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const token = await MockERC20.deploy("Test", "TST", 18);

      const amount = ethers.parseEther("100");
      await token.mint(await splitter.getAddress(), amount);

      const tx = await splitter
        .connect(facilitator)
        .splitPayment(
          await token.getAddress(),
          owner.address,
          endpoint.address,
          amount
        );

      const receipt = await tx.wait();
      console.log(`    Gas used: ${receipt?.gasUsed.toString()}`);

      // Should be under 100k gas
      expect(receipt?.gasUsed).to.be.lt(100000);
    });
  });
});
