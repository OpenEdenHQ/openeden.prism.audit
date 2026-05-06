import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployExpressContracts } from "../fixtures/expressDeployments";

describe("Express - requestDirectRedeem", function () {
  // Bootstrap: user1 mints PRISM via instantMint so they have a token balance
  async function deployWithMint() {
    const fixture = await deployExpressContracts();
    const { express, usdo, oem, user1, user2 } = fixture;

    const mintAmt = ethers.parseUnits("10000", 18);
    await express
      .connect(user1)
      .instantMint(await usdo.getAddress(), user1.address, mintAmt, 0);

    await oem
      .connect(user1)
      .approve(await express.getAddress(), ethers.MaxUint256);
    await oem
      .connect(user2)
      .approve(await express.getAddress(), ethers.MaxUint256);

    return fixture;
  }

  // Arbitrary "RLUSD" address — informational only; contract never calls it
  const RLUSD = ethers.getAddress("0x000000000000000000000000000000000000cafe");

  describe("happy path", function () {
    it("burns tokens immediately and emits event", async function () {
      const { express, oem, user1 } = await loadFixture(deployWithMint);

      const tokenAmount = ethers.parseUnits("1000", 18);
      const supplyBefore = await oem.totalSupply();
      const userBalBefore = await oem.balanceOf(user1.address);

      await expect(
        express
          .connect(user1)
          .requestDirectRedeem(RLUSD, tokenAmount, user1.address),
      )
        .to.emit(express, "OffchainRedeem")
        .withArgs(user1.address, user1.address, RLUSD, tokenAmount);

      expect(await oem.totalSupply()).to.equal(supplyBefore - tokenAmount);
      expect(await oem.balanceOf(user1.address)).to.equal(
        userBalBefore - tokenAmount,
      );
    });
  });

  describe("reverts", function () {
    it("reverts on zero amount", async function () {
      const { express, user1 } = await loadFixture(deployWithMint);
      await expect(
        express.connect(user1).requestDirectRedeem(RLUSD, 0, user1.address),
      ).to.be.revertedWithCustomError(express, "InvalidAmount");
    });

    it("reverts on zero asset address", async function () {
      const { express, user1 } = await loadFixture(deployWithMint);
      await expect(
        express
          .connect(user1)
          .requestDirectRedeem(
            ethers.ZeroAddress,
            ethers.parseUnits("100", 18),
            user1.address,
          ),
      ).to.be.revertedWithCustomError(express, "InvalidAddress");
    });

    it("reverts when asset equals underlying", async function () {
      const { express, user1 } = await loadFixture(deployWithMint);
      const underlyingAddr = await express.underlying();
      await expect(
        express
          .connect(user1)
          .requestDirectRedeem(
            underlyingAddr,
            ethers.parseUnits("100", 18),
            user1.address,
          ),
      ).to.be.revertedWithCustomError(express, "UnderlyingNotAllowed");
    });

    it("reverts when from is not KYC-listed", async function () {
      const { express, whitelister, user1 } = await loadFixture(deployWithMint);
      await express.connect(whitelister).revokeKycInBulk([user1.address]);

      await expect(
        express
          .connect(user1)
          .requestDirectRedeem(
            RLUSD,
            ethers.parseUnits("100", 18),
            user1.address,
          ),
      ).to.be.revertedWithCustomError(express, "NotInKycList");
    });

    it("reverts when to is not KYC-listed", async function () {
      const { express, user1 } = await loadFixture(deployWithMint);
      const nonKyc = ethers.Wallet.createRandom().address;
      await expect(
        express
          .connect(user1)
          .requestDirectRedeem(RLUSD, ethers.parseUnits("100", 18), nonKyc),
      ).to.be.revertedWithCustomError(express, "NotInKycList");
    });

    it("reverts when paused", async function () {
      const { express, pauser, user1 } = await loadFixture(deployWithMint);
      await express.connect(pauser).pauseRedeem();
      await expect(
        express
          .connect(user1)
          .requestDirectRedeem(
            RLUSD,
            ethers.parseUnits("100", 18),
            user1.address,
          ),
      ).to.be.revertedWith("Pausable: Redeem paused");
    });

    it("reverts when token balance insufficient", async function () {
      const { express, oem, user1 } = await loadFixture(deployWithMint);
      const balance = await oem.balanceOf(user1.address);
      await expect(
        express
          .connect(user1)
          .requestDirectRedeem(RLUSD, balance + 1n, user1.address),
      ).to.be.reverted;
    });
  });

  describe("coexistence with queued flow", function () {
    it("interleaves with instantMint and redeemRequest without drift", async function () {
      const { express, oem, usdo, user1, user2, operator } =
        await loadFixture(deployWithMint);

      // user2 mints PRISM
      const mintAmt = ethers.parseUnits("5000", 18);
      await express
        .connect(user2)
        .instantMint(await usdo.getAddress(), user2.address, mintAmt, 0);
      await oem
        .connect(user2)
        .approve(await express.getAddress(), ethers.MaxUint256);

      const supplyAfterMint = await oem.totalSupply();

      // user1 direct-redeems
      await express
        .connect(user1)
        .requestDirectRedeem(
          RLUSD,
          ethers.parseUnits("1000", 18),
          user1.address,
        );

      // Total supply drops by 1000 (immediate burn)
      expect(await oem.totalSupply()).to.equal(
        supplyAfterMint - ethers.parseUnits("1000", 18),
      );
      // Redemption queue is unaffected
      expect(await express.getRedemptionQueueLength()).to.equal(0n);

      // user2 queued-redeems
      await express
        .connect(user2)
        .redeemRequest(user2.address, ethers.parseUnits("500", 18));

      // Queue length now 1; total supply still only reflects user1's burn
      // (user2's tokens are escrowed in Express, not yet burned).
      expect(await express.getRedemptionQueueLength()).to.equal(1n);
      expect(await oem.totalSupply()).to.equal(
        supplyAfterMint - ethers.parseUnits("1000", 18),
      );

      // user1 direct-redeems again
      await express
        .connect(user1)
        .requestDirectRedeem(
          RLUSD,
          ethers.parseUnits("300", 18),
          user1.address,
        );

      // Direct redeem doesn't touch the queue
      expect(await express.getRedemptionQueueLength()).to.equal(1n);
      expect(await oem.totalSupply()).to.equal(
        supplyAfterMint - ethers.parseUnits("1300", 18),
      );

      // Process the queued redeem — this burns user2's 500 and pays out USDO
      await express.connect(operator).processRedemptionQueue(0);

      expect(await express.getRedemptionQueueLength()).to.equal(0n);
      expect(await oem.totalSupply()).to.equal(
        supplyAfterMint - ethers.parseUnits("1800", 18),
      );
    });
  });
});
