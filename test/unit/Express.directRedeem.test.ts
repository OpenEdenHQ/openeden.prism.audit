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
  const RLUSD = ethers.getAddress(
    "0x000000000000000000000000000000000000cafe",
  );

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
});
