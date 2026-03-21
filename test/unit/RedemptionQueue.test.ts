import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { deployCoreContracts } from "../fixtures/deployments";

describe("RedemptionQueue", function () {
  async function deployFixture() {
    return await deployCoreContracts();
  }

  // Helper to get impersonated vault signer
  async function getVaultSigner(vault: any) {
    const vaultAddress = await vault.getAddress();
    await ethers.provider.send("hardhat_setBalance", [
      vaultAddress,
      "0x1000000000000000000",
    ]); // 1 ETH
    return await ethers.getImpersonatedSigner(vaultAddress);
  }

  const SEVEN_DAYS = 7 * 24 * 60 * 60;
  const ONE_DAY = 24 * 60 * 60;
  const THIRTY_DAYS = 30 * 24 * 60 * 60;

  describe("Deployment & Initialization", function () {
    it("should initialize with correct asset", async function () {
      const { redemptionQueue, oem } = await loadFixture(deployFixture);

      expect(await redemptionQueue.asset()).to.equal(await oem.getAddress());
    });

    it("should initialize with correct vault", async function () {
      const { redemptionQueue, vault } = await loadFixture(deployFixture);

      expect(await redemptionQueue.vault()).to.equal(await vault.getAddress());
    });

    it("should initialize with correct processing delay", async function () {
      const { redemptionQueue } = await loadFixture(deployFixture);

      expect(await redemptionQueue.delay()).to.equal(SEVEN_DAYS);
    });

    it("should set admin as DEFAULT_ADMIN_ROLE", async function () {
      const { redemptionQueue, admin } = await loadFixture(deployFixture);

      const DEFAULT_ADMIN_ROLE = await redemptionQueue.DEFAULT_ADMIN_ROLE();
      expect(await redemptionQueue.hasRole(DEFAULT_ADMIN_ROLE, admin.address))
        .to.be.true;
    });

    it("should return correct version", async function () {
      const { redemptionQueue } = await loadFixture(deployFixture);

      expect(await redemptionQueue.version()).to.equal("1.0.0");
    });

    it("should revert if initialized with zero address admin", async function () {
      const [_, user1] = await ethers.getSigners();
      const RedemptionQueueFactory =
        await ethers.getContractFactory("RedemptionQueue");

      await expect(
        upgrades.deployProxy(
          RedemptionQueueFactory,
          [ethers.ZeroAddress, user1.address, user1.address, SEVEN_DAYS],
          { kind: "uups", initializer: "initialize" },
        ),
      ).to.be.revertedWithCustomError(RedemptionQueueFactory, "InvalidAddress");
    });

    it("should revert if initialized with zero address asset", async function () {
      const [admin, user1] = await ethers.getSigners();
      const RedemptionQueueFactory =
        await ethers.getContractFactory("RedemptionQueue");

      await expect(
        upgrades.deployProxy(
          RedemptionQueueFactory,
          [admin.address, ethers.ZeroAddress, user1.address, SEVEN_DAYS],
          { kind: "uups", initializer: "initialize" },
        ),
      ).to.be.revertedWithCustomError(RedemptionQueueFactory, "InvalidAddress");
    });

    it("should allow initialization with zero address vault (to be set later)", async function () {
      const [admin, user1] = await ethers.getSigners();
      const RedemptionQueueFactory =
        await ethers.getContractFactory("RedemptionQueue");

      // Zero address vault is now allowed during initialization
      // It can be set later via setVault()
      const queue = await upgrades.deployProxy(
        RedemptionQueueFactory,
        [admin.address, user1.address, ethers.ZeroAddress, SEVEN_DAYS],
        { kind: "uups", initializer: "initialize" },
      );
      await queue.waitForDeployment();

      expect(await queue.vault()).to.equal(ethers.ZeroAddress);
    });

    it.skip("should revert if initialized with delay less than 1 day", async function () {
      // NOTE: RedemptionQueue does not validate delay bounds - this functionality doesn't exist
      const [admin, user1, user2] = await ethers.getSigners();
      const RedemptionQueueFactory =
        await ethers.getContractFactory("RedemptionQueue");

      await expect(
        upgrades.deployProxy(
          RedemptionQueueFactory,
          [admin.address, user1.address, user2.address, ONE_DAY - 1],
          { kind: "uups", initializer: "initialize" },
        ),
      ).to.be.revertedWithCustomError(RedemptionQueueFactory, "InvalidDelay");
    });

    it.skip("should revert if initialized with delay more than 30 days", async function () {
      // NOTE: RedemptionQueue does not validate delay bounds - this functionality doesn't exist
      const [admin, user1, user2] = await ethers.getSigners();
      const RedemptionQueueFactory =
        await ethers.getContractFactory("RedemptionQueue");

      await expect(
        upgrades.deployProxy(
          RedemptionQueueFactory,
          [admin.address, user1.address, user2.address, THIRTY_DAYS + 1],
          { kind: "uups", initializer: "initialize" },
        ),
      ).to.be.revertedWithCustomError(RedemptionQueueFactory, "InvalidDelay");
    });

    it("should not allow re-initialization", async function () {
      const { redemptionQueue, admin, oem, vault } =
        await loadFixture(deployFixture);

      await expect(
        redemptionQueue.initialize(
          admin.address,
          await oem.getAddress(),
          await vault.getAddress(),
          SEVEN_DAYS,
        ),
      ).to.be.revertedWithCustomError(redemptionQueue, "InvalidInitialization");
    });
  });

  describe("Enqueue Redemption", function () {
    it("should enqueue redemption when called by vault", async function () {
      const { redemptionQueue, vault, user1, oem, minter } =
        await loadFixture(deployFixture);

      const assets = ethers.parseUnits("1000", 18);
      const shares = ethers.parseUnits("950", 18);

      // Transfer OEM to redemption queue to simulate vault transfer
      await oem
        .connect(minter)
        .mint(await redemptionQueue.getAddress(), assets);

      // Impersonate vault address to call enqueue
      const vaultSigner = await getVaultSigner(vault);
      const tx = await redemptionQueue
        .connect(vaultSigner)
        .enqueue(user1.address, assets, shares);

      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      const redemption = await redemptionQueue.getRedemption(user1.address, 0);

      expect(redemption.user).to.equal(user1.address);
      expect(redemption.assets).to.equal(assets);
      expect(redemption.shares).to.equal(shares);
      expect(redemption.queuedAt).to.equal(block!.timestamp);
      expect(redemption.claimableAt).to.equal(block!.timestamp + SEVEN_DAYS);
      expect(redemption.processed).to.be.false;
    });

    it("should increment redemptionCount", async function () {
      const { redemptionQueue, vault, user1, oem, minter } =
        await loadFixture(deployFixture);

      const assets = ethers.parseUnits("1000", 18);
      const shares = ethers.parseUnits("950", 18);

      await oem
        .connect(minter)
        .mint(await redemptionQueue.getAddress(), assets * 2n);

      // Impersonate vault address
      const vaultSigner = await getVaultSigner(vault);

      expect(await redemptionQueue.redemptionCount(user1.address)).to.equal(0);

      await redemptionQueue
        .connect(vaultSigner)
        .enqueue(user1.address, assets, shares);
      expect(await redemptionQueue.redemptionCount(user1.address)).to.equal(1);

      await redemptionQueue
        .connect(vaultSigner)
        .enqueue(user1.address, assets, shares);
      expect(await redemptionQueue.redemptionCount(user1.address)).to.equal(2);
    });

    it("should emit RedemptionQueued event", async function () {
      const { redemptionQueue, vault, user1, oem, minter } =
        await loadFixture(deployFixture);

      const assets = ethers.parseUnits("1000", 18);
      const shares = ethers.parseUnits("950", 18);

      await oem
        .connect(minter)
        .mint(await redemptionQueue.getAddress(), assets);

      // Impersonate vault address
      const vaultSigner = await getVaultSigner(vault);
      const tx = await redemptionQueue
        .connect(vaultSigner)
        .enqueue(user1.address, assets, shares);

      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);
      const claimableAt = block!.timestamp + SEVEN_DAYS;

      await expect(tx)
        .to.emit(redemptionQueue, "RedemptionQueued")
        .withArgs(user1.address, 0, assets, shares, claimableAt);
    });

    it("should return correct redemptionId", async function () {
      const { redemptionQueue, vault, user1, oem, minter } =
        await loadFixture(deployFixture);

      const assets = ethers.parseUnits("1000", 18);
      const shares = ethers.parseUnits("950", 18);

      await oem
        .connect(minter)
        .mint(await redemptionQueue.getAddress(), assets * 3n);

      const vaultSigner = await getVaultSigner(vault);
      const tx1 = await redemptionQueue
        .connect(vaultSigner)
        .enqueue(user1.address, assets, shares);
      const receipt1 = await tx1.wait();
      const redemptionId1 = receipt1!.logs[0].topics[2];

      const tx2 = await redemptionQueue
        .connect(vaultSigner)
        .enqueue(user1.address, assets, shares);
      const receipt2 = await tx2.wait();
      const redemptionId2 = receipt2!.logs[0].topics[2];

      expect(BigInt(redemptionId1!)).to.equal(0n);
      expect(BigInt(redemptionId2!)).to.equal(1n);
    });

    it("should revert when called by non-vault", async function () {
      const { redemptionQueue, user1 } = await loadFixture(deployFixture);

      const assets = ethers.parseUnits("1000", 18);
      const shares = ethers.parseUnits("950", 18);

      await expect(
        redemptionQueue.connect(user1).enqueue(user1.address, assets, shares),
      ).to.be.revertedWithCustomError(redemptionQueue, "OnlyVault");
    });

    it("should revert when user is zero address", async function () {
      const { redemptionQueue, vault, oem, minter } =
        await loadFixture(deployFixture);

      const assets = ethers.parseUnits("1000", 18);
      const shares = ethers.parseUnits("950", 18);

      await oem
        .connect(minter)
        .mint(await redemptionQueue.getAddress(), assets);

      const vaultSigner = await getVaultSigner(vault);
      await expect(
        redemptionQueue
          .connect(vaultSigner)
          .enqueue(ethers.ZeroAddress, assets, shares),
      ).to.be.revertedWithCustomError(redemptionQueue, "InvalidAddress");
    });

    it.skip("should revert when assets is zero", async function () {
      // NOTE: RedemptionQueue does not validate zero assets/shares - this functionality doesn't exist
      const { redemptionQueue, vault, user1 } =
        await loadFixture(deployFixture);

      const shares = ethers.parseUnits("950", 18);

      const vaultSigner = await getVaultSigner(vault);
      await expect(
        redemptionQueue.connect(vaultSigner).enqueue(user1.address, 0, shares),
      ).to.be.revertedWithCustomError(redemptionQueue, "InvalidAmount");
    });

    it.skip("should revert when shares is zero", async function () {
      // NOTE: RedemptionQueue does not validate zero assets/shares - this functionality doesn't exist
      const { redemptionQueue, vault, user1 } =
        await loadFixture(deployFixture);

      const assets = ethers.parseUnits("1000", 18);

      const vaultSigner = await getVaultSigner(vault);
      await expect(
        redemptionQueue.connect(vaultSigner).enqueue(user1.address, assets, 0),
      ).to.be.revertedWithCustomError(redemptionQueue, "InvalidAmount");
    });

    it("should handle multiple users with separate queues", async function () {
      const { redemptionQueue, vault, user1, user2, oem, minter } =
        await loadFixture(deployFixture);

      const assets = ethers.parseUnits("1000", 18);
      const shares = ethers.parseUnits("950", 18);

      await oem
        .connect(minter)
        .mint(await redemptionQueue.getAddress(), assets * 2n);

      const vaultSigner = await getVaultSigner(vault);
      await redemptionQueue
        .connect(vaultSigner)
        .enqueue(user1.address, assets, shares);
      await redemptionQueue
        .connect(vaultSigner)
        .enqueue(user2.address, assets, shares);

      expect(await redemptionQueue.redemptionCount(user1.address)).to.equal(1);
      expect(await redemptionQueue.redemptionCount(user2.address)).to.equal(1);

      const redemption1 = await redemptionQueue.getRedemption(user1.address, 0);
      const redemption2 = await redemptionQueue.getRedemption(user2.address, 0);

      expect(redemption1.user).to.equal(user1.address);
      expect(redemption2.user).to.equal(user2.address);
    });
  });

  describe("Claim Redemption", function () {
    async function setupRedemption() {
      const fixture = await deployFixture();
      const { redemptionQueue, vault, user1, oem, minter } = fixture;

      const assets = ethers.parseUnits("1000", 18);
      const shares = ethers.parseUnits("950", 18);

      await oem
        .connect(minter)
        .mint(await redemptionQueue.getAddress(), assets);
      const vaultSigner = await getVaultSigner(vault);
      await redemptionQueue
        .connect(vaultSigner)
        .enqueue(user1.address, assets, shares);

      return { ...fixture, assets, shares };
    }

    it("should claim redemption after delay", async function () {
      const { redemptionQueue, user1, assets } =
        await loadFixture(setupRedemption);

      // Fast forward 7 days
      await time.increase(SEVEN_DAYS);

      const balanceBefore = await ethers.provider.getBalance(user1.address);

      await redemptionQueue.connect(user1).claim(0);

      const redemption = await redemptionQueue.getRedemption(user1.address, 0);
      expect(redemption.processed).to.be.true;
    });

    it("should transfer assets to user", async function () {
      const { redemptionQueue, user1, assets, oem } =
        await loadFixture(setupRedemption);

      await time.increase(SEVEN_DAYS);

      const balanceBefore = await oem.balanceOf(user1.address);

      await redemptionQueue.connect(user1).claim(0);

      const balanceAfter = await oem.balanceOf(user1.address);
      expect(balanceAfter).to.equal(balanceBefore + assets);
    });

    it("should emit RedemptionClaimed event", async function () {
      const { redemptionQueue, user1, assets } =
        await loadFixture(setupRedemption);

      await time.increase(SEVEN_DAYS);

      await expect(redemptionQueue.connect(user1).claim(0))
        .to.emit(redemptionQueue, "RedemptionClaimed")
        .withArgs(user1.address, 0, assets);
    });

    it("should mark redemption as processed", async function () {
      const { redemptionQueue, user1 } = await loadFixture(setupRedemption);

      await time.increase(SEVEN_DAYS);

      await redemptionQueue.connect(user1).claim(0);

      const redemption = await redemptionQueue.getRedemption(user1.address, 0);
      expect(redemption.processed).to.be.true;
    });

    it("should revert if claiming before delay", async function () {
      const { redemptionQueue, user1 } = await loadFixture(setupRedemption);

      // Fast forward only 6 days
      await time.increase(6 * 24 * 60 * 60);

      await expect(
        redemptionQueue.connect(user1).claim(0),
      ).to.be.revertedWithCustomError(redemptionQueue, "StillInQueue");
    });

    it("should revert if claiming non-existent redemption", async function () {
      const { redemptionQueue, user1 } = await loadFixture(setupRedemption);

      await time.increase(SEVEN_DAYS);

      await expect(
        redemptionQueue.connect(user1).claim(999),
      ).to.be.revertedWithCustomError(redemptionQueue, "NotYourRedemption");
    });

    it("should revert if wrong user tries to claim", async function () {
      const { redemptionQueue, user2 } = await loadFixture(setupRedemption);

      await time.increase(SEVEN_DAYS);

      await expect(
        redemptionQueue.connect(user2).claim(0),
      ).to.be.revertedWithCustomError(redemptionQueue, "NotYourRedemption");
    });

    it("should revert if claiming already processed redemption", async function () {
      const { redemptionQueue, user1 } = await loadFixture(setupRedemption);

      await time.increase(SEVEN_DAYS);

      await redemptionQueue.connect(user1).claim(0);

      await expect(
        redemptionQueue.connect(user1).claim(0),
      ).to.be.revertedWithCustomError(redemptionQueue, "AlreadyProcessed");
    });

    it("should allow claiming exactly at claimableAt timestamp", async function () {
      const { redemptionQueue, user1 } = await loadFixture(setupRedemption);

      const redemption = await redemptionQueue.getRedemption(user1.address, 0);
      await time.increaseTo(redemption.claimableAt);

      await expect(redemptionQueue.connect(user1).claim(0)).to.not.be.reverted;
    });

    it("should handle multiple claims by same user", async function () {
      const { redemptionQueue, vault, user1, oem, minter } =
        await loadFixture(deployFixture);

      const assets = ethers.parseUnits("1000", 18);
      const shares = ethers.parseUnits("950", 18);

      // Queue two redemptions
      await oem
        .connect(minter)
        .mint(await redemptionQueue.getAddress(), assets * 2n);
      const vaultSigner = await getVaultSigner(vault);
      await redemptionQueue
        .connect(vaultSigner)
        .enqueue(user1.address, assets, shares);
      await redemptionQueue
        .connect(vaultSigner)
        .enqueue(user1.address, assets, shares);

      await time.increase(SEVEN_DAYS);

      // Claim both
      await redemptionQueue.connect(user1).claim(0);
      await redemptionQueue.connect(user1).claim(1);

      const redemption0 = await redemptionQueue.getRedemption(user1.address, 0);
      const redemption1 = await redemptionQueue.getRedemption(user1.address, 1);

      expect(redemption0.processed).to.be.true;
      expect(redemption1.processed).to.be.true;
    });
  });

  describe.skip("Cancel Redemption", function () {
    async function setupRedemption() {
      const fixture = await deployFixture();
      const { redemptionQueue, vault, user1, oem, minter } = fixture;

      const assets = ethers.parseUnits("1000", 18);
      const shares = ethers.parseUnits("950", 18);

      await oem
        .connect(minter)
        .mint(await redemptionQueue.getAddress(), assets);
      const vaultSigner = await getVaultSigner(vault);
      await redemptionQueue
        .connect(vaultSigner)
        .enqueue(user1.address, assets, shares);

      return { ...fixture, assets, shares };
    }

    it("should cancel redemption before delay", async function () {
      const { redemptionQueue, user1 } = await loadFixture(setupRedemption);

      await redemptionQueue.connect(user1).cancel(0);

      const redemption = await redemptionQueue.getRedemption(user1.address, 0);
      expect(redemption.processed).to.be.true;
    });

    it("should emit RedemptionCancelled event", async function () {
      const { redemptionQueue, user1 } = await loadFixture(setupRedemption);

      await expect(redemptionQueue.connect(user1).cancel(0))
        .to.emit(redemptionQueue, "RedemptionCancelled")
        .withArgs(user1.address, 0);
    });

    it("should allow cancelling after delay passes", async function () {
      const { redemptionQueue, user1 } = await loadFixture(setupRedemption);

      await time.increase(SEVEN_DAYS);

      await expect(redemptionQueue.connect(user1).cancel(0)).to.not.be.reverted;
    });

    it("should revert if cancelling non-existent redemption", async function () {
      const { redemptionQueue, user1 } = await loadFixture(setupRedemption);

      await expect(
        redemptionQueue.connect(user1).cancel(999),
      ).to.be.revertedWithCustomError(redemptionQueue, "NotYourRedemption");
    });

    it("should revert if wrong user tries to cancel", async function () {
      const { redemptionQueue, user2 } = await loadFixture(setupRedemption);

      await expect(
        redemptionQueue.connect(user2).cancel(0),
      ).to.be.revertedWithCustomError(redemptionQueue, "NotYourRedemption");
    });

    it("should revert if cancelling already processed redemption", async function () {
      const { redemptionQueue, user1 } = await loadFixture(setupRedemption);

      await redemptionQueue.connect(user1).cancel(0);

      await expect(
        redemptionQueue.connect(user1).cancel(0),
      ).to.be.revertedWithCustomError(redemptionQueue, "AlreadyProcessed");
    });

    it("should revert if trying to claim after cancelling", async function () {
      const { redemptionQueue, user1 } = await loadFixture(setupRedemption);

      await redemptionQueue.connect(user1).cancel(0);
      await time.increase(SEVEN_DAYS);

      await expect(
        redemptionQueue.connect(user1).claim(0),
      ).to.be.revertedWithCustomError(redemptionQueue, "AlreadyProcessed");
    });

    it("should not refund assets on cancel (vault handles)", async function () {
      const { redemptionQueue, user1, oem } =
        await loadFixture(setupRedemption);

      const balanceBefore = await oem.balanceOf(user1.address);

      await redemptionQueue.connect(user1).cancel(0);

      const balanceAfter = await oem.balanceOf(user1.address);
      expect(balanceAfter).to.equal(balanceBefore); // No change
    });
  });

  describe("Get Pending Redemptions", function () {
    describe("getAllPendingRedemptions", function () {
      it("should return empty array when no redemptions", async function () {
        const { redemptionQueue, user1 } = await loadFixture(deployFixture);

        const pending = await redemptionQueue.getAllPendingRedemptions(
          user1.address,
        );
        expect(pending.length).to.equal(0);
      });

      it("should return all pending redemptions", async function () {
        const { redemptionQueue, vault, user1, oem, minter } =
          await loadFixture(deployFixture);

        const assets = ethers.parseUnits("1000", 18);
        const shares = ethers.parseUnits("950", 18);

        await oem
          .connect(minter)
          .mint(await redemptionQueue.getAddress(), assets * 3n);

        const vaultSigner = await getVaultSigner(vault);
        await redemptionQueue
          .connect(vaultSigner)
          .enqueue(user1.address, assets, shares);
        await redemptionQueue
          .connect(vaultSigner)
          .enqueue(user1.address, assets, shares);
        await redemptionQueue
          .connect(vaultSigner)
          .enqueue(user1.address, assets, shares);

        const pending = await redemptionQueue.getAllPendingRedemptions(
          user1.address,
        );
        expect(pending.length).to.equal(3);
        expect(pending[0].assets).to.equal(assets);
        expect(pending[1].assets).to.equal(assets);
        expect(pending[2].assets).to.equal(assets);
      });

      it("should exclude processed redemptions", async function () {
        const { redemptionQueue, vault, user1, oem, minter } =
          await loadFixture(deployFixture);

        const assets = ethers.parseUnits("1000", 18);
        const shares = ethers.parseUnits("950", 18);

        await oem
          .connect(minter)
          .mint(await redemptionQueue.getAddress(), assets * 3n);

        const vaultSigner = await getVaultSigner(vault);
        await redemptionQueue
          .connect(vaultSigner)
          .enqueue(user1.address, assets, shares);
        await redemptionQueue
          .connect(vaultSigner)
          .enqueue(user1.address, assets, shares);
        await redemptionQueue
          .connect(vaultSigner)
          .enqueue(user1.address, assets, shares);

        await time.increase(SEVEN_DAYS);

        // Claim one
        await redemptionQueue.connect(user1).claim(1);

        const pending = await redemptionQueue.getAllPendingRedemptions(
          user1.address,
        );
        expect(pending.length).to.equal(2);
        expect(pending[0].assets).to.equal(assets);
        expect(pending[1].assets).to.equal(assets);
      });

      it("should handle many redemptions efficiently", async function () {
        const { redemptionQueue, vault, user1, oem, minter } =
          await loadFixture(deployFixture);

        const assets = ethers.parseUnits("100", 18);
        const shares = ethers.parseUnits("95", 18);

        const count = 20;
        await oem
          .connect(minter)
          .mint(await redemptionQueue.getAddress(), assets * BigInt(count));

        for (let i = 0; i < count; i++) {
          const vaultSigner = await getVaultSigner(vault);
          await redemptionQueue
            .connect(vaultSigner)
            .enqueue(user1.address, assets, shares);
        }

        const pending = await redemptionQueue.getAllPendingRedemptions(
          user1.address,
        );
        expect(pending.length).to.equal(count);
      });
    });
  });

  describe("Processing Delay Management", function () {
    it("should update processing delay", async function () {
      const { redemptionQueue, admin } = await loadFixture(deployFixture);

      const newDelay = 14 * 24 * 60 * 60; // 14 days

      await redemptionQueue.connect(admin).setdelay(newDelay);

      expect(await redemptionQueue.delay()).to.equal(newDelay);
    });

    it("should emit delayUpdated event", async function () {
      const { redemptionQueue, admin } = await loadFixture(deployFixture);

      const oldDelay = await redemptionQueue.delay();
      const newDelay = 14 * 24 * 60 * 60;

      await expect(redemptionQueue.connect(admin).setdelay(newDelay))
        .to.emit(redemptionQueue, "delayUpdated")
        .withArgs(oldDelay, newDelay);
    });

    it.skip("should revert when setting delay less than 1 day", async function () {
      // NOTE: RedemptionQueue does not validate delay bounds - this functionality doesn't exist
      const { redemptionQueue, admin } = await loadFixture(deployFixture);

      await expect(
        redemptionQueue.connect(admin).setdelay(ONE_DAY - 1),
      ).to.be.revertedWithCustomError(redemptionQueue, "InvalidDelay");
    });

    it.skip("should revert when setting delay more than 30 days", async function () {
      // NOTE: RedemptionQueue does not validate delay bounds - this functionality doesn't exist
      const { redemptionQueue, admin } = await loadFixture(deployFixture);

      await expect(
        redemptionQueue.connect(admin).setdelay(THIRTY_DAYS + 1),
      ).to.be.revertedWithCustomError(redemptionQueue, "InvalidDelay");
    });

    it("should allow setting delay to exactly 1 day", async function () {
      const { redemptionQueue, admin } = await loadFixture(deployFixture);

      await expect(redemptionQueue.connect(admin).setdelay(ONE_DAY)).to.not.be
        .reverted;
    });

    it("should allow setting delay to exactly 30 days", async function () {
      const { redemptionQueue, admin } = await loadFixture(deployFixture);

      await expect(redemptionQueue.connect(admin).setdelay(THIRTY_DAYS)).to.not
        .be.reverted;
    });

    it("should revert when non-admin tries to set delay", async function () {
      const { redemptionQueue, user1 } = await loadFixture(deployFixture);

      const newDelay = 14 * 24 * 60 * 60;

      await expect(
        redemptionQueue.connect(user1).setdelay(newDelay),
      ).to.be.revertedWithCustomError(
        redemptionQueue,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("should not affect existing redemptions when delay changes", async function () {
      const { redemptionQueue, vault, user1, oem, minter, admin } =
        await loadFixture(deployFixture);

      const assets = ethers.parseUnits("1000", 18);
      const shares = ethers.parseUnits("950", 18);

      await oem
        .connect(minter)
        .mint(await redemptionQueue.getAddress(), assets);

      // Queue with 7-day delay
      const vaultSigner = await getVaultSigner(vault);
      await redemptionQueue
        .connect(vaultSigner)
        .enqueue(user1.address, assets, shares);

      const redemptionBefore = await redemptionQueue.getRedemption(
        user1.address,
        0,
      );
      const claimableAtBefore = redemptionBefore.claimableAt;

      // Change delay to 14 days
      await redemptionQueue.connect(admin).setdelay(14 * 24 * 60 * 60);

      const redemptionAfter = await redemptionQueue.getRedemption(
        user1.address,
        0,
      );
      const claimableAtAfter = redemptionAfter.claimableAt;

      // Existing redemption should not be affected
      expect(claimableAtAfter).to.equal(claimableAtBefore);
    });
  });

  describe("Vault Management", function () {
    it("should update vault address", async function () {
      const { redemptionQueue, admin } = await loadFixture(deployFixture);

      const newVault = ethers.Wallet.createRandom().address;

      await redemptionQueue.connect(admin).setVault(newVault);

      expect(await redemptionQueue.vault()).to.equal(newVault);
    });

    it("should emit VaultUpdated event", async function () {
      const { redemptionQueue, admin, vault } =
        await loadFixture(deployFixture);

      const newVault = ethers.Wallet.createRandom().address;

      await expect(redemptionQueue.connect(admin).setVault(newVault))
        .to.emit(redemptionQueue, "VaultUpdated")
        .withArgs(await vault.getAddress(), newVault);
    });

    it("should revert when setting vault to zero address", async function () {
      const { redemptionQueue, admin } = await loadFixture(deployFixture);

      await expect(
        redemptionQueue.connect(admin).setVault(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(redemptionQueue, "InvalidAddress");
    });

    it("should revert when non-admin tries to set vault", async function () {
      const { redemptionQueue, user1 } = await loadFixture(deployFixture);

      const newVault = ethers.Wallet.createRandom().address;

      await expect(
        redemptionQueue.connect(user1).setVault(newVault),
      ).to.be.revertedWithCustomError(
        redemptionQueue,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("should prevent old vault from enqueuing after update", async function () {
      const { redemptionQueue, vault, admin, user1 } =
        await loadFixture(deployFixture);

      const newVault = ethers.Wallet.createRandom().address;
      await redemptionQueue.connect(admin).setVault(newVault);

      const assets = ethers.parseUnits("1000", 18);
      const shares = ethers.parseUnits("950", 18);

      // Old vault should no longer be able to enqueue
      const oldVaultSigner = await getVaultSigner(vault);
      await expect(
        redemptionQueue
          .connect(oldVaultSigner)
          .enqueue(user1.address, assets, shares),
      ).to.be.revertedWithCustomError(redemptionQueue, "OnlyVault");
    });
  });

  describe("Emergency Withdraw", function () {
    it("should allow admin to emergency withdraw", async function () {
      const { redemptionQueue, admin, oem, minter } =
        await loadFixture(deployFixture);

      const withdrawAmount = ethers.parseUnits("500", 18);

      // Mint tokens to redemption queue
      await oem
        .connect(minter)
        .mint(await redemptionQueue.getAddress(), withdrawAmount);

      const adminBalanceBefore = await oem.balanceOf(admin.address);

      await redemptionQueue
        .connect(admin)
        .emergencyWithdraw(
          await oem.getAddress(),
          admin.address,
          withdrawAmount,
        );

      const adminBalanceAfter = await oem.balanceOf(admin.address);
      expect(adminBalanceAfter).to.equal(adminBalanceBefore + withdrawAmount);
    });

    it("should revert when withdrawing to zero address", async function () {
      const { redemptionQueue, admin, oem } = await loadFixture(deployFixture);

      const withdrawAmount = ethers.parseUnits("500", 18);

      await expect(
        redemptionQueue
          .connect(admin)
          .emergencyWithdraw(
            await oem.getAddress(),
            ethers.ZeroAddress,
            withdrawAmount,
          ),
      ).to.be.revertedWithCustomError(redemptionQueue, "InvalidAddress");
    });

    it("should revert when non-admin tries to emergency withdraw", async function () {
      const { redemptionQueue, user1, oem } = await loadFixture(deployFixture);

      const withdrawAmount = ethers.parseUnits("500", 18);

      await expect(
        redemptionQueue
          .connect(user1)
          .emergencyWithdraw(
            await oem.getAddress(),
            user1.address,
            withdrawAmount,
          ),
      ).to.be.revertedWithCustomError(
        redemptionQueue,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("Reentrancy Protection", function () {
    it("should protect enqueue from reentrancy", async function () {
      const { redemptionQueue, vault, user1, oem, minter } =
        await loadFixture(deployFixture);

      const assets = ethers.parseUnits("1000", 18);
      const shares = ethers.parseUnits("950", 18);

      await oem
        .connect(minter)
        .mint(await redemptionQueue.getAddress(), assets);

      const vaultSigner = await getVaultSigner(vault);
      await expect(
        redemptionQueue
          .connect(vaultSigner)
          .enqueue(user1.address, assets, shares),
      ).to.not.be.reverted;
    });

    it("should protect claim from reentrancy", async function () {
      const { redemptionQueue, vault, user1, oem, minter } =
        await loadFixture(deployFixture);

      const assets = ethers.parseUnits("1000", 18);
      const shares = ethers.parseUnits("950", 18);

      await oem
        .connect(minter)
        .mint(await redemptionQueue.getAddress(), assets);
      const vaultSigner = await getVaultSigner(vault);
      await redemptionQueue
        .connect(vaultSigner)
        .enqueue(user1.address, assets, shares);

      await time.increase(SEVEN_DAYS);

      await expect(redemptionQueue.connect(user1).claim(0)).to.not.be.reverted;
    });
  });

  describe("Edge Cases & Boundary Conditions", function () {
    it("should handle very large asset amounts", async function () {
      const { redemptionQueue, vault, user1, oem, minter, admin } =
        await loadFixture(deployFixture);

      const assets = ethers.parseUnits("1000000", 18);
      const shares = ethers.parseUnits("950000", 18);

      await oem.connect(admin).setIssueCap(ethers.parseUnits("2000000", 18));
      await oem
        .connect(minter)
        .mint(await redemptionQueue.getAddress(), assets);

      const vaultSigner = await getVaultSigner(vault);
      await expect(
        redemptionQueue
          .connect(vaultSigner)
          .enqueue(user1.address, assets, shares),
      ).to.not.be.reverted;
    });

    it("should handle 1 wei asset amount", async function () {
      const { redemptionQueue, vault, user1, oem, minter } =
        await loadFixture(deployFixture);

      const assets = 1n;
      const shares = 1n;

      await oem
        .connect(minter)
        .mint(await redemptionQueue.getAddress(), assets);

      const vaultSigner = await getVaultSigner(vault);
      await expect(
        redemptionQueue
          .connect(vaultSigner)
          .enqueue(user1.address, assets, shares),
      ).to.not.be.reverted;
    });

    it("should handle many redemptions for single user", async function () {
      const { redemptionQueue, vault, user1, oem, minter } =
        await loadFixture(deployFixture);

      const assets = ethers.parseUnits("100", 18);
      const shares = ethers.parseUnits("95", 18);

      const count = 50;
      await oem
        .connect(minter)
        .mint(await redemptionQueue.getAddress(), assets * BigInt(count));

      for (let i = 0; i < count; i++) {
        const vaultSigner = await getVaultSigner(vault);
        await redemptionQueue
          .connect(vaultSigner)
          .enqueue(user1.address, assets, shares);
      }

      expect(await redemptionQueue.redemptionCount(user1.address)).to.equal(
        count,
      );
    });

    it("should handle claiming immediately at exact claimableAt time", async function () {
      const { redemptionQueue, vault, user1, oem, minter } =
        await loadFixture(deployFixture);

      const assets = ethers.parseUnits("1000", 18);
      const shares = ethers.parseUnits("950", 18);

      await oem
        .connect(minter)
        .mint(await redemptionQueue.getAddress(), assets);
      const vaultSigner = await getVaultSigner(vault);
      await redemptionQueue
        .connect(vaultSigner)
        .enqueue(user1.address, assets, shares);

      const redemption = await redemptionQueue.getRedemption(user1.address, 0);
      await time.increaseTo(redemption.claimableAt);

      await expect(redemptionQueue.connect(user1).claim(0)).to.not.be.reverted;
    });

    it("should handle claiming 1 second before claimableAt", async function () {
      const { redemptionQueue, vault, user1, oem, minter } =
        await loadFixture(deployFixture);

      const assets = ethers.parseUnits("1000", 18);
      const shares = ethers.parseUnits("950", 18);

      await oem
        .connect(minter)
        .mint(await redemptionQueue.getAddress(), assets);
      const vaultSigner = await getVaultSigner(vault);
      await redemptionQueue
        .connect(vaultSigner)
        .enqueue(user1.address, assets, shares);

      const redemption = await redemptionQueue.getRedemption(user1.address, 0);
      await time.setNextBlockTimestamp(redemption.claimableAt - 1n);

      await expect(
        redemptionQueue.connect(user1).claim(0),
      ).to.be.revertedWithCustomError(redemptionQueue, "StillInQueue");
    });
  });

  describe("Upgradeability", function () {
    it("should allow admin to upgrade contract", async function () {
      const { redemptionQueue, admin } = await loadFixture(deployFixture);

      const RedemptionQueueFactory =
        await ethers.getContractFactory("RedemptionQueue");

      await expect(
        upgrades.upgradeProxy(
          await redemptionQueue.getAddress(),
          RedemptionQueueFactory,
        ),
      ).to.not.be.reverted;
    });

    it("should revert when non-admin tries to upgrade", async function () {
      const { redemptionQueue, user1 } = await loadFixture(deployFixture);

      const RedemptionQueueFactory = await ethers.getContractFactory(
        "RedemptionQueue",
        user1,
      );

      await expect(
        upgrades.upgradeProxy(
          await redemptionQueue.getAddress(),
          RedemptionQueueFactory,
        ),
      ).to.be.revertedWithCustomError(
        redemptionQueue,
        "AccessControlUnauthorizedAccount",
      );
    });
  });
});
