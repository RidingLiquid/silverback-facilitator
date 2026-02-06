import { expect } from "chai";
import { ethers } from "hardhat";
import { X402FeeSplitter, MockERC20 } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("X402FeeSplitter", function () {
  let splitter: X402FeeSplitter;
  let usdc: MockERC20;
  let back: MockERC20;
  let weth: MockERC20;

  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let facilitator: SignerWithAddress;
  let endpoint: SignerWithAddress;
  let payer: SignerWithAddress;
  let attacker: SignerWithAddress;

  const DEFAULT_FEE_BPS = 10; // 0.1%

  beforeEach(async function () {
    [owner, treasury, facilitator, endpoint, payer, attacker] =
      await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    back = await MockERC20.deploy("Silverback", "BACK", 18);
    weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);

    // Deploy splitter
    const FeeSplitter = await ethers.getContractFactory("X402FeeSplitter");
    splitter = await FeeSplitter.deploy(
      treasury.address,
      DEFAULT_FEE_BPS,
      facilitator.address
    );

    // Configure token fees
    await splitter.setTokenFee(await back.getAddress(), 0); // BACK exempt
    await splitter.setTokenFee(await usdc.getAddress(), 10); // 0.1%
    await splitter.setTokenFee(await weth.getAddress(), 25); // 0.25%
  });

  describe("Constructor", function () {
    it("should set treasury correctly", async function () {
      expect(await splitter.treasury()).to.equal(treasury.address);
    });

    it("should set default fee correctly", async function () {
      expect(await splitter.defaultFeeBps()).to.equal(DEFAULT_FEE_BPS);
    });

    it("should authorize initial facilitator", async function () {
      expect(await splitter.authorizedFacilitators(facilitator.address)).to.be
        .true;
      expect(await splitter.facilitatorCount()).to.equal(1);
    });

    it("should revert on zero treasury", async function () {
      const FeeSplitter = await ethers.getContractFactory("X402FeeSplitter");
      await expect(
        FeeSplitter.deploy(ethers.ZeroAddress, DEFAULT_FEE_BPS, facilitator.address)
      ).to.be.revertedWithCustomError(splitter, "InvalidTreasury");
    });

    it("should revert on fee > 10%", async function () {
      const FeeSplitter = await ethers.getContractFactory("X402FeeSplitter");
      await expect(
        FeeSplitter.deploy(treasury.address, 1001, facilitator.address)
      ).to.be.revertedWithCustomError(splitter, "FeeTooHigh");
    });
  });

  describe("Access Control", function () {
    it("should only allow facilitator to call splitPayment", async function () {
      const amount = ethers.parseUnits("1", 6); // 1 USDC
      await usdc.mint(await splitter.getAddress(), amount);

      // Non-facilitator should fail
      await expect(
        splitter
          .connect(attacker)
          .splitPayment(
            await usdc.getAddress(),
            payer.address,
            endpoint.address,
            amount
          )
      ).to.be.revertedWithCustomError(splitter, "NotAuthorizedFacilitator");

      // Facilitator should succeed
      await expect(
        splitter
          .connect(facilitator)
          .splitPayment(
            await usdc.getAddress(),
            payer.address,
            endpoint.address,
            amount
          )
      ).to.not.be.reverted;
    });

    it("should allow owner to add facilitators", async function () {
      await splitter.setFacilitator(attacker.address, true);
      expect(await splitter.authorizedFacilitators(attacker.address)).to.be
        .true;
      expect(await splitter.facilitatorCount()).to.equal(2);
    });

    it("should allow owner to remove facilitators", async function () {
      await splitter.setFacilitator(facilitator.address, false);
      expect(await splitter.authorizedFacilitators(facilitator.address)).to.be
        .false;
      expect(await splitter.facilitatorCount()).to.equal(0);
    });
  });

  describe("Fee Configuration", function () {
    it("should return configured fee for known tokens", async function () {
      expect(await splitter.getTokenFee(await back.getAddress())).to.equal(0);
      expect(await splitter.getTokenFee(await usdc.getAddress())).to.equal(10);
      expect(await splitter.getTokenFee(await weth.getAddress())).to.equal(25);
    });

    it("should return default fee for unknown tokens", async function () {
      const randomToken = ethers.Wallet.createRandom().address;
      expect(await splitter.getTokenFee(randomToken)).to.equal(DEFAULT_FEE_BPS);
    });

    it("should update token fee", async function () {
      await splitter.setTokenFee(await usdc.getAddress(), 50);
      expect(await splitter.getTokenFee(await usdc.getAddress())).to.equal(50);
    });

    it("should batch update token fees", async function () {
      await splitter.setTokenFeesBatch(
        [await usdc.getAddress(), await weth.getAddress()],
        [15, 30]
      );
      expect(await splitter.getTokenFee(await usdc.getAddress())).to.equal(15);
      expect(await splitter.getTokenFee(await weth.getAddress())).to.equal(30);
    });

    it("should revert on fee > 10%", async function () {
      await expect(
        splitter.setTokenFee(await usdc.getAddress(), 1001)
      ).to.be.revertedWithCustomError(splitter, "FeeTooHigh");
    });
  });

  describe("Split Payment", function () {
    it("should correctly split USDC payment (0.1% fee)", async function () {
      const amount = ethers.parseUnits("1", 6); // 1 USDC
      await usdc.mint(await splitter.getAddress(), amount);

      const tx = await splitter
        .connect(facilitator)
        .splitPayment(
          await usdc.getAddress(),
          payer.address,
          endpoint.address,
          amount
        );

      // Fee = 1,000,000 * 10 / 10000 = 1000 (0.001 USDC)
      const expectedFee = 1000n;
      const expectedNet = amount - expectedFee;

      expect(await usdc.balanceOf(endpoint.address)).to.equal(expectedNet);
      expect(await usdc.balanceOf(treasury.address)).to.equal(expectedFee);
      expect(await usdc.balanceOf(await splitter.getAddress())).to.equal(0);

      // Check event
      await expect(tx)
        .to.emit(splitter, "PaymentSplit")
        .withArgs(
          await usdc.getAddress(),
          payer.address,
          endpoint.address,
          amount,
          expectedNet,
          expectedFee,
          facilitator.address
        );
    });

    it("should not charge fee for BACK (exempt)", async function () {
      const amount = ethers.parseEther("100"); // 100 BACK
      await back.mint(await splitter.getAddress(), amount);

      await splitter
        .connect(facilitator)
        .splitPayment(
          await back.getAddress(),
          payer.address,
          endpoint.address,
          amount
        );

      // No fee for BACK
      expect(await back.balanceOf(endpoint.address)).to.equal(amount);
      expect(await back.balanceOf(treasury.address)).to.equal(0);
    });

    it("should correctly split WETH payment (0.25% fee)", async function () {
      const amount = ethers.parseEther("1"); // 1 WETH
      await weth.mint(await splitter.getAddress(), amount);

      await splitter
        .connect(facilitator)
        .splitPayment(
          await weth.getAddress(),
          payer.address,
          endpoint.address,
          amount
        );

      // Fee = 1 ETH * 25 / 10000 = 0.0025 ETH
      const expectedFee = ethers.parseEther("0.0025");
      const expectedNet = amount - expectedFee;

      expect(await weth.balanceOf(endpoint.address)).to.equal(expectedNet);
      expect(await weth.balanceOf(treasury.address)).to.equal(expectedFee);
    });

    it("should update stats after settlement", async function () {
      const amount = ethers.parseUnits("1", 6);
      await usdc.mint(await splitter.getAddress(), amount);

      await splitter
        .connect(facilitator)
        .splitPayment(
          await usdc.getAddress(),
          payer.address,
          endpoint.address,
          amount
        );

      expect(await splitter.totalSettlements()).to.equal(1);
      expect(await splitter.collectedFees(await usdc.getAddress())).to.equal(
        1000
      );
      expect(
        await splitter.totalVolumeByToken(await usdc.getAddress())
      ).to.equal(amount);
    });
  });

  describe("Input Validation", function () {
    it("should revert on zero token", async function () {
      await expect(
        splitter
          .connect(facilitator)
          .splitPayment(
            ethers.ZeroAddress,
            payer.address,
            endpoint.address,
            1000
          )
      ).to.be.revertedWithCustomError(splitter, "InvalidToken");
    });

    it("should revert on zero recipient", async function () {
      await usdc.mint(await splitter.getAddress(), 1000);
      await expect(
        splitter
          .connect(facilitator)
          .splitPayment(
            await usdc.getAddress(),
            payer.address,
            ethers.ZeroAddress,
            1000
          )
      ).to.be.revertedWithCustomError(splitter, "InvalidRecipient");
    });

    it("should revert on self as recipient", async function () {
      await usdc.mint(await splitter.getAddress(), 1000);
      await expect(
        splitter
          .connect(facilitator)
          .splitPayment(
            await usdc.getAddress(),
            payer.address,
            await splitter.getAddress(),
            1000
          )
      ).to.be.revertedWithCustomError(splitter, "InvalidRecipient");
    });

    it("should revert on zero amount", async function () {
      await expect(
        splitter
          .connect(facilitator)
          .splitPayment(
            await usdc.getAddress(),
            payer.address,
            endpoint.address,
            0
          )
      ).to.be.revertedWithCustomError(splitter, "InvalidAmount");
    });

    it("should revert on insufficient balance", async function () {
      // Don't fund the splitter
      await expect(
        splitter
          .connect(facilitator)
          .splitPayment(
            await usdc.getAddress(),
            payer.address,
            endpoint.address,
            1000
          )
      ).to.be.revertedWithCustomError(splitter, "InsufficientBalance");
    });
  });

  describe("Whitelist Mode", function () {
    it("should block non-whitelisted tokens when enabled", async function () {
      await splitter.setWhitelistMode(true);
      await usdc.mint(await splitter.getAddress(), 1000);

      await expect(
        splitter
          .connect(facilitator)
          .splitPayment(
            await usdc.getAddress(),
            payer.address,
            endpoint.address,
            1000
          )
      ).to.be.revertedWithCustomError(splitter, "TokenNotWhitelisted");
    });

    it("should allow whitelisted tokens", async function () {
      await splitter.setWhitelistMode(true);
      await splitter.setTokenWhitelisted(await usdc.getAddress(), true);
      await usdc.mint(await splitter.getAddress(), 1000);

      await expect(
        splitter
          .connect(facilitator)
          .splitPayment(
            await usdc.getAddress(),
            payer.address,
            endpoint.address,
            1000
          )
      ).to.not.be.reverted;
    });
  });

  describe("Pause", function () {
    it("should block splitPayment when paused", async function () {
      await splitter.pause();
      await usdc.mint(await splitter.getAddress(), 1000);

      await expect(
        splitter
          .connect(facilitator)
          .splitPayment(
            await usdc.getAddress(),
            payer.address,
            endpoint.address,
            1000
          )
      ).to.be.revertedWithCustomError(splitter, "EnforcedPause");
    });

    it("should allow splitPayment after unpause", async function () {
      await splitter.pause();
      await splitter.unpause();
      await usdc.mint(await splitter.getAddress(), 1000);

      await expect(
        splitter
          .connect(facilitator)
          .splitPayment(
            await usdc.getAddress(),
            payer.address,
            endpoint.address,
            1000
          )
      ).to.not.be.reverted;
    });
  });

  describe("Emergency Withdraw", function () {
    it("should withdraw to treasury", async function () {
      await usdc.mint(await splitter.getAddress(), 1000);

      await splitter.emergencyWithdraw(await usdc.getAddress(), 1000);

      expect(await usdc.balanceOf(treasury.address)).to.equal(1000);
      expect(await usdc.balanceOf(await splitter.getAddress())).to.equal(0);
    });

    it("should withdraw to custom address", async function () {
      await usdc.mint(await splitter.getAddress(), 1000);

      await splitter.emergencyWithdrawTo(
        await usdc.getAddress(),
        attacker.address,
        1000
      );

      expect(await usdc.balanceOf(attacker.address)).to.equal(1000);
    });
  });

  describe("Ownership", function () {
    it("should require two-step ownership transfer", async function () {
      await splitter.transferOwnership(attacker.address);

      // Still original owner
      expect(await splitter.owner()).to.equal(owner.address);
      expect(await splitter.pendingOwner()).to.equal(attacker.address);

      // Accept ownership
      await splitter.connect(attacker).acceptOwnership();
      expect(await splitter.owner()).to.equal(attacker.address);
    });
  });

  describe("View Functions", function () {
    it("should return correct stats", async function () {
      const [
        settlements,
        treasuryAddr,
        defaultFee,
        numFacilitators,
        isPaused,
        isWhitelistMode,
      ] = await splitter.getStats();

      expect(settlements).to.equal(0);
      expect(treasuryAddr).to.equal(treasury.address);
      expect(defaultFee).to.equal(DEFAULT_FEE_BPS);
      expect(numFacilitators).to.equal(1);
      expect(isPaused).to.be.false;
      expect(isWhitelistMode).to.be.false;
    });

    it("should calculate split correctly", async function () {
      const [net, fee] = await splitter.calculateSplit(
        await usdc.getAddress(),
        1000000n
      );

      expect(fee).to.equal(1000n);
      expect(net).to.equal(999000n);
    });
  });

  describe("Edge Cases", function () {
    it("should round fee down for small amounts", async function () {
      // 99 * 10 / 10000 = 0.099 → rounds to 0
      await usdc.mint(await splitter.getAddress(), 99);

      await splitter
        .connect(facilitator)
        .splitPayment(
          await usdc.getAddress(),
          payer.address,
          endpoint.address,
          99
        );

      expect(await usdc.balanceOf(endpoint.address)).to.equal(99);
      expect(await usdc.balanceOf(treasury.address)).to.equal(0);
    });

    it("should handle large amounts correctly", async function () {
      const amount = ethers.parseUnits("1000000", 6); // 1M USDC
      await usdc.mint(await splitter.getAddress(), amount);

      await splitter
        .connect(facilitator)
        .splitPayment(
          await usdc.getAddress(),
          payer.address,
          endpoint.address,
          amount
        );

      // 0.1% of 1M = 1000 USDC = 1,000,000,000 units
      const expectedFee = ethers.parseUnits("1000", 6);
      expect(await usdc.balanceOf(treasury.address)).to.equal(expectedFee);
    });
  });
});
