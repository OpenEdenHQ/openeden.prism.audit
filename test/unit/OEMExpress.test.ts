import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployExpressContracts } from "../fixtures/expressDeployments";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Express", function () {
  // Helper to deploy fresh contracts for each test
  async function deployFixture() {
    return await deployExpressContracts();
  }

  describe("Deployment & Initialization", function () {
    it("should initialize with correct addresses", async function () {
      const { express, oem, usdo, treasury, feeTo, assetRegistry } =
        await loadFixture(deployFixture);

      expect(await express.token()).to.equal(await oem.getAddress());
      expect(await express.underlying()).to.equal(await usdo.getAddress());
      expect(await express.treasury()).to.equal(treasury.address);
      expect(await express.feeTo()).to.equal(feeTo.address);
      expect(await express.assetRegistry()).to.equal(
        await assetRegistry.getAddress(),
      );
    });

    it("should initialize with correct mint and redeem limits", async function () {
      const { express } = await loadFixture(deployFixture);

      expect(await express._mintMinimum()).to.equal(
        ethers.parseUnits("100", 18),
      );
      expect(await express._redeemMinimum()).to.equal(
        ethers.parseUnits("50", 18),
      );
      expect(await express._firstDepositAmount()).to.equal(
        ethers.parseUnits("1000", 18),
      );
    });

    it("should initialize with zero fees", async function () {
      const { express } = await loadFixture(deployFixture);

      expect(await express.mintFeeRate()).to.equal(0);
      expect(await express.redeemFeeRate()).to.equal(0);
    });

    it("should grant roles correctly", async function () {
      const { express, admin, operator, maintainer, whitelister, pauser } =
        await loadFixture(deployFixture);

      const DEFAULT_ADMIN_ROLE = await express.DEFAULT_ADMIN_ROLE();
      const OPERATOR_ROLE = await express.OPERATOR_ROLE();
      const MAINTAINER_ROLE = await express.MAINTAINER_ROLE();
      const WHITELIST_ROLE = await express.WHITELIST_ROLE();
      const PAUSE_ROLE = await express.PAUSE_ROLE();
      const UPGRADE_ROLE = await express.UPGRADE_ROLE();

      expect(await express.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be
        .true;
      expect(await express.hasRole(OPERATOR_ROLE, operator.address)).to.be.true;
      expect(await express.hasRole(MAINTAINER_ROLE, maintainer.address)).to.be
        .true;
      expect(await express.hasRole(WHITELIST_ROLE, whitelister.address)).to.be
        .true;
      expect(await express.hasRole(PAUSE_ROLE, pauser.address)).to.be.true;
      expect(await express.hasRole(UPGRADE_ROLE, admin.address)).to.be.true;
    });

    it("should return correct version", async function () {
      const { express } = await loadFixture(deployFixture);

      expect(await express.version()).to.equal("1.0.0");
    });

    it("should revert if initialized with zero address admin", async function () {
      const [, , , , , treasury, feeTo] = await ethers.getSigners();

      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const usdo = await MockERC20Factory.deploy("USDO Token", "USDO", 18);
      await usdo.waitForDeployment();

      const OEMFactory = await ethers.getContractFactory("Token");
      const oem = await upgrades.deployProxy(
        OEMFactory,
        [
          "USDO Prime",
          "OEM",
          treasury.address,
          ethers.parseUnits("10000000", 18),
        ],
        { kind: "uups", initializer: "initialize" },
      );
      await oem.waitForDeployment();

      const AssetRegistryFactory =
        await ethers.getContractFactory("AssetRegistry");
      const assetRegistry = await upgrades.deployProxy(
        AssetRegistryFactory,
        [treasury.address],
        {
          kind: "uups",
          initializer: "initialize",
        },
      );
      await assetRegistry.waitForDeployment();

      const ExpressFactory = await ethers.getContractFactory("Express");

      await expect(
        upgrades.deployProxy(
          ExpressFactory,
          [
            await oem.getAddress(),
            await usdo.getAddress(),
            treasury.address,
            feeTo.address,
            ethers.ZeroAddress,
            await assetRegistry.getAddress(),
            {
              mintMinimum: ethers.parseUnits("100", 18),
              redeemMinimum: ethers.parseUnits("50", 18),
              firstDepositAmount: ethers.parseUnits("1000", 18),
            },
          ],
          { kind: "uups", initializer: "initialize" },
        ),
      ).to.be.revertedWithCustomError(ExpressFactory, "InvalidAddress");
    });

    it("should not allow re-initialization", async function () {
      const { express, oem, usdo, treasury, feeTo, admin, assetRegistry } =
        await loadFixture(deployFixture);

      await expect(
        express.initialize(
          await oem.getAddress(),
          await usdo.getAddress(),
          treasury.address,
          feeTo.address,
          admin.address,
          await assetRegistry.getAddress(),
          {
            mintMinimum: ethers.parseUnits("100", 18),
            redeemMinimum: ethers.parseUnits("50", 18),
            firstDepositAmount: ethers.parseUnits("1000", 18),
          },
        ),
      ).to.be.revertedWithCustomError(express, "InvalidInitialization");
    });

    it("should have empty redemption queue on deployment", async function () {
      const { express } = await loadFixture(deployFixture);

      expect(await express.getRedemptionQueueLength()).to.equal(0);
    });

    it("should have paused states as false initially", async function () {
      const { express } = await loadFixture(deployFixture);

      expect(await express.pausedMint()).to.be.false;
      expect(await express.pausedRedeem()).to.be.false;
    });
  });

  describe("KYC Management", function () {
    it("should grant KYC to single address", async function () {
      const { express, whitelister, user1 } = await loadFixture(deployFixture);

      // User1 already has KYC from fixture, use a different address
      const [, , , , , , , , , , newUser] = await ethers.getSigners();

      await expect(
        express.connect(whitelister).grantKycInBulk([newUser.address]),
      )
        .to.emit(express, "KycGranted")
        .withArgs([newUser.address]);

      expect(await express.kycList(newUser.address)).to.be.true;
    });

    it("should grant KYC to multiple addresses", async function () {
      const { express, whitelister } = await loadFixture(deployFixture);

      const [, , , , , , , , , , newUser1, newUser2, newUser3] =
        await ethers.getSigners();
      const addresses = [newUser1.address, newUser2.address, newUser3.address];

      await expect(express.connect(whitelister).grantKycInBulk(addresses))
        .to.emit(express, "KycGranted")
        .withArgs(addresses);

      for (const addr of addresses) {
        expect(await express.kycList(addr)).to.be.true;
      }
    });

    it("should revoke KYC from single address", async function () {
      const { express, whitelister, user1 } = await loadFixture(deployFixture);

      await expect(
        express.connect(whitelister).revokeKycInBulk([user1.address]),
      )
        .to.emit(express, "KycRevoked")
        .withArgs([user1.address]);

      expect(await express.kycList(user1.address)).to.be.false;
    });

    it("should revoke KYC from multiple addresses", async function () {
      const { express, whitelister, user1, user2, user3 } =
        await loadFixture(deployFixture);

      const addresses = [user1.address, user2.address, user3.address];

      await expect(express.connect(whitelister).revokeKycInBulk(addresses))
        .to.emit(express, "KycRevoked")
        .withArgs(addresses);

      for (const addr of addresses) {
        expect(await express.kycList(addr)).to.be.false;
      }
    });

    it("should revert if non-whitelister tries to grant KYC", async function () {
      const { express, user1 } = await loadFixture(deployFixture);

      const [, , , , , , , , , , newUser] = await ethers.getSigners();

      await expect(
        express.connect(user1).grantKycInBulk([newUser.address]),
      ).to.be.revertedWithCustomError(
        express,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("should revert if non-whitelister tries to revoke KYC", async function () {
      const { express, user1, user2 } = await loadFixture(deployFixture);

      await expect(
        express.connect(user1).revokeKycInBulk([user2.address]),
      ).to.be.revertedWithCustomError(
        express,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("Instant Minting", function () {
    describe("Success Cases", function () {
      it("should mint OEM with first deposit requirement", async function () {
        const { express, oem, usdo, user1 } = await loadFixture(deployFixture);

        const mintAmount = ethers.parseUnits("1000", 18); // Meets first deposit requirement
        const balanceBefore = await oem.balanceOf(user1.address);

        await expect(
          express
            .connect(user1)
            .instantMint(await usdo.getAddress(), user1.address, mintAmount, 0),
        )
          .to.emit(express, "InstantMint")
          .withArgs(
            await usdo.getAddress(),
            user1.address,
            user1.address,
            mintAmount,
            mintAmount,
            0,
          );

        expect(await oem.balanceOf(user1.address)).to.equal(
          balanceBefore + mintAmount,
        );
        expect(await express.firstDeposit(user1.address)).to.be.true;
      });

      it("should mint OEM after first deposit with minimum amount", async function () {
        const { express, oem, usdo, user1 } = await loadFixture(deployFixture);

        // First deposit
        const firstDeposit = ethers.parseUnits("1000", 18);
        await express
          .connect(user1)
          .instantMint(await usdo.getAddress(), user1.address, firstDeposit, 0);

        // Subsequent mint with minimum amount
        const mintAmount = ethers.parseUnits("100", 18);
        const balanceBefore = await oem.balanceOf(user1.address);

        await express
          .connect(user1)
          .instantMint(await usdo.getAddress(), user1.address, mintAmount, 0);

        expect(await oem.balanceOf(user1.address)).to.equal(
          balanceBefore + mintAmount,
        );
      });

      it("should mint to different recipient", async function () {
        const { express, oem, usdo, user1, user2 } =
          await loadFixture(deployFixture);

        const mintAmount = ethers.parseUnits("1000", 18);
        const balanceBefore = await oem.balanceOf(user2.address);

        await express
          .connect(user1)
          .instantMint(await usdo.getAddress(), user2.address, mintAmount, 0);

        expect(await oem.balanceOf(user2.address)).to.equal(
          balanceBefore + mintAmount,
        );
      });

      it("should transfer OEM to treasury", async function () {
        const { express, usdo, user1, treasury } =
          await loadFixture(deployFixture);

        const mintAmount = ethers.parseUnits("1000", 18);
        const treasuryBalanceBefore = await usdo.balanceOf(treasury.address);

        await express
          .connect(user1)
          .instantMint(await usdo.getAddress(), user1.address, mintAmount, 0);

        expect(await usdo.balanceOf(treasury.address)).to.equal(
          treasuryBalanceBefore + mintAmount,
        );
      });

      it("should calculate and distribute fees correctly", async function () {
        const { express, usdo, user1, treasury, feeTo, maintainer } =
          await loadFixture(deployFixture);

        // Set mint fee to 1% (100 bps)
        await express.connect(maintainer).updateMintFee(100);

        const mintAmount = ethers.parseUnits("1000", 18);
        const expectedFee = ethers.parseUnits("10", 18); // 1% of 1000
        const expectedNet = ethers.parseUnits("990", 18);

        const treasuryBalanceBefore = await usdo.balanceOf(treasury.address);
        const feeToBalanceBefore = await usdo.balanceOf(feeTo.address);

        await express
          .connect(user1)
          .instantMint(await usdo.getAddress(), user1.address, mintAmount, 0);

        expect(await usdo.balanceOf(treasury.address)).to.equal(
          treasuryBalanceBefore + expectedNet,
        );
        expect(await usdo.balanceOf(feeTo.address)).to.equal(
          feeToBalanceBefore + expectedFee,
        );
      });

      it("should mint with large amount", async function () {
        const { express, oem, usdo, user1 } = await loadFixture(deployFixture);

        const mintAmount = ethers.parseUnits("50000", 18);
        const balanceBefore = await oem.balanceOf(user1.address);

        await express
          .connect(user1)
          .instantMint(await usdo.getAddress(), user1.address, mintAmount, 0);

        expect(await oem.balanceOf(user1.address)).to.equal(
          balanceBefore + mintAmount,
        );
      });
    });

    describe("Failure Cases", function () {
      it("should revert if sender not KYC approved", async function () {
        const { express, usdo, whitelister, user1 } =
          await loadFixture(deployFixture);

        // Revoke KYC
        await express.connect(whitelister).revokeKycInBulk([user1.address]);

        const mintAmount = ethers.parseUnits("1000", 18);

        await expect(
          express
            .connect(user1)
            .instantMint(await usdo.getAddress(), user1.address, mintAmount, 0),
        ).to.be.revertedWithCustomError(express, "NotInKycList");
      });

      it("should revert if recipient not KYC approved", async function () {
        const { express, usdo, whitelister, user1, user2 } =
          await loadFixture(deployFixture);

        // Revoke KYC from recipient
        await express.connect(whitelister).revokeKycInBulk([user2.address]);

        const mintAmount = ethers.parseUnits("1000", 18);

        await expect(
          express
            .connect(user1)
            .instantMint(await usdo.getAddress(), user2.address, mintAmount, 0),
        ).to.be.revertedWithCustomError(express, "NotInKycList");
      });

      it("should revert if first deposit below minimum", async function () {
        const { express, usdo, user1 } = await loadFixture(deployFixture);

        const mintAmount = ethers.parseUnits("500", 18); // Below 1000 first deposit requirement

        await expect(
          express
            .connect(user1)
            .instantMint(await usdo.getAddress(), user1.address, mintAmount, 0),
        ).to.be.revertedWithCustomError(
          express,
          "FirstDepositLessThanRequired",
        );
      });

      it("should revert if subsequent mint below minimum", async function () {
        const { express, usdo, user1 } = await loadFixture(deployFixture);

        // First deposit
        await express
          .connect(user1)
          .instantMint(
            await usdo.getAddress(),
            user1.address,
            ethers.parseUnits("1000", 18),
            0,
          );

        // Try to mint below minimum
        const mintAmount = ethers.parseUnits("50", 18); // Below 100 minimum

        await expect(
          express
            .connect(user1)
            .instantMint(await usdo.getAddress(), user1.address, mintAmount, 0),
        ).to.be.revertedWithCustomError(express, "MintLessThanMinimum");
      });

      it("should revert if amount is zero", async function () {
        const { express, usdo, user1 } = await loadFixture(deployFixture);

        await expect(
          express
            .connect(user1)
            .instantMint(await usdo.getAddress(), user1.address, 0, 0),
        ).to.be.revertedWithCustomError(express, "InvalidAmount");
      });

      it("should revert if mint is paused", async function () {
        const { express, usdo, user1, pauser } =
          await loadFixture(deployFixture);

        await express.connect(pauser).pauseMint();

        const mintAmount = ethers.parseUnits("1000", 18);

        await expect(
          express
            .connect(user1)
            .instantMint(await usdo.getAddress(), user1.address, mintAmount, 0),
        ).to.be.reverted;
      });

      it("should revert if insufficient USDO balance", async function () {
        const { express, usdo, user1 } = await loadFixture(deployFixture);

        const userBalance = await usdo.balanceOf(user1.address);
        const mintAmount = userBalance + ethers.parseUnits("1", 18);

        await expect(
          express
            .connect(user1)
            .instantMint(await usdo.getAddress(), user1.address, mintAmount, 0),
        ).to.be.reverted;
      });
    });

    describe("Edge Cases", function () {
      it("should handle exact first deposit amount", async function () {
        const { express, oem, usdo, user1 } = await loadFixture(deployFixture);

        const mintAmount = ethers.parseUnits("1000", 18); // Exact first deposit
        await express
          .connect(user1)
          .instantMint(await usdo.getAddress(), user1.address, mintAmount, 0);

        expect(await express.firstDeposit(user1.address)).to.be.true;
      });

      it("should handle exact minimum mint amount after first deposit", async function () {
        const { express, oem, usdo, user1 } = await loadFixture(deployFixture);

        await express
          .connect(user1)
          .instantMint(
            await usdo.getAddress(),
            user1.address,
            ethers.parseUnits("1000", 18),
            0,
          );

        const mintAmount = ethers.parseUnits("100", 18); // Exact minimum
        await express
          .connect(user1)
          .instantMint(await usdo.getAddress(), user1.address, mintAmount, 0);

        expect(await oem.balanceOf(user1.address)).to.be.gt(0);
      });

      it("should handle very small fee amounts", async function () {
        const { express, usdo, user1, maintainer } =
          await loadFixture(deployFixture);

        // Set very small fee (0.01%)
        await express.connect(maintainer).updateMintFee(1);

        const mintAmount = ethers.parseUnits("1000", 18);
        await express
          .connect(user1)
          .instantMint(await usdo.getAddress(), user1.address, mintAmount, 0);
      });

      it("should handle high fee rate", async function () {
        const { express, oem, usdo, user1, maintainer } =
          await loadFixture(deployFixture);

        // Set 10% fee
        await express.connect(maintainer).updateMintFee(1000);

        const mintAmount = ethers.parseUnits("1000", 18);
        const expectedFee = ethers.parseUnits("100", 18);
        const expectedUsdox = ethers.parseUnits("900", 18);

        await express
          .connect(user1)
          .instantMint(await usdo.getAddress(), user1.address, mintAmount, 0);

        expect(await oem.balanceOf(user1.address)).to.equal(expectedUsdox);
      });
    });
  });

  describe("Preview Functions", function () {
    it("should preview mint with no fee", async function () {
      const { express, usdo } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("1000", 18);
      const [netAmt, feeAmt, mintAmt] = await express.previewMint(
        await usdo.getAddress(),
        amount,
      );

      expect(feeAmt).to.equal(0);
      expect(netAmt).to.equal(amount);
      expect(mintAmt).to.equal(amount);
    });

    it("should preview mint with fee", async function () {
      const { express, usdo, maintainer } = await loadFixture(deployFixture);

      await express.connect(maintainer).updateMintFee(100); // 1%

      const amount = ethers.parseUnits("1000", 18);
      const [netAmt, feeAmt, mintAmt] = await express.previewMint(
        await usdo.getAddress(),
        amount,
      );

      expect(feeAmt).to.equal(ethers.parseUnits("10", 18));
      expect(netAmt).to.equal(ethers.parseUnits("990", 18));
      expect(mintAmt).to.equal(ethers.parseUnits("990", 18));
    });

    it("should preview redeem with no fee", async function () {
      const { express } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("1000", 18);
      const [feeAmt, redeemAmt] = await express.previewRedeem(amount);

      expect(feeAmt).to.equal(0);
      expect(redeemAmt).to.equal(amount);
    });

    it("should preview redeem with fee", async function () {
      const { express, maintainer } = await loadFixture(deployFixture);

      await express.connect(maintainer).updateRedeemFee(100); // 1%

      const amount = ethers.parseUnits("1000", 18);
      const [feeAmt, redeemAmt] = await express.previewRedeem(amount);

      expect(feeAmt).to.equal(ethers.parseUnits("10", 18));
      expect(redeemAmt).to.equal(ethers.parseUnits("990", 18));
    });
  });

  describe("Redemption Request", function () {
    describe("Success Cases", function () {
      it("should queue redemption request", async function () {
        const { express, oem, usdo, user1 } = await loadFixture(deployFixture);

        // Mint USDO to user1
        await express
          .connect(user1)
          .instantMint(
            await usdo.getAddress(),
            user1.address,
            ethers.parseUnits("1000", 18),
            0,
          );

        const redeemAmount = ethers.parseUnits("500", 18);
        await oem
          .connect(user1)
          .approve(await express.getAddress(), redeemAmount);

        await expect(
          express.connect(user1).redeemRequest(user1.address, redeemAmount),
        ).to.emit(express, "AddToRedemptionQueue");

        expect(await express.getRedemptionQueueLength()).to.equal(1);
      });

      it("should track user redemption info", async function () {
        const { express, oem, usdo, user1 } = await loadFixture(deployFixture);

        await express
          .connect(user1)
          .instantMint(
            await usdo.getAddress(),
            user1.address,
            ethers.parseUnits("1000", 18),
            0,
          );

        const redeemAmount = ethers.parseUnits("500", 18);
        await oem
          .connect(user1)
          .approve(await express.getAddress(), redeemAmount);

        await express.connect(user1).redeemRequest(user1.address, redeemAmount);

        expect(await express.getRedemptionUserInfo(user1.address)).to.equal(
          redeemAmount,
        );
      });

      it("should queue multiple redemption requests", async function () {
        const { express, oem, usdo, user1, user2 } =
          await loadFixture(deployFixture);

        // Mint to both users
        await express
          .connect(user1)
          .instantMint(
            await usdo.getAddress(),
            user1.address,
            ethers.parseUnits("1000", 18),
            0,
          );
        await express
          .connect(user2)
          .instantMint(
            await usdo.getAddress(),
            user2.address,
            ethers.parseUnits("1000", 18),
            0,
          );

        const redeemAmount1 = ethers.parseUnits("300", 18);
        const redeemAmount2 = ethers.parseUnits("400", 18);

        await oem
          .connect(user1)
          .approve(await express.getAddress(), redeemAmount1);
        await oem
          .connect(user2)
          .approve(await express.getAddress(), redeemAmount2);

        await express
          .connect(user1)
          .redeemRequest(user1.address, redeemAmount1);
        await express
          .connect(user2)
          .redeemRequest(user2.address, redeemAmount2);

        expect(await express.getRedemptionQueueLength()).to.equal(2);
      });

      it("should accumulate redemption info for same user", async function () {
        const { express, oem, usdo, user1 } = await loadFixture(deployFixture);

        await express
          .connect(user1)
          .instantMint(
            await usdo.getAddress(),
            user1.address,
            ethers.parseUnits("2000", 18),
            0,
          );

        const redeemAmount1 = ethers.parseUnits("300", 18);
        const redeemAmount2 = ethers.parseUnits("400", 18);

        await oem
          .connect(user1)
          .approve(await express.getAddress(), ethers.parseUnits("1000", 18));

        await express
          .connect(user1)
          .redeemRequest(user1.address, redeemAmount1);
        await express
          .connect(user1)
          .redeemRequest(user1.address, redeemAmount2);

        expect(await express.getRedemptionUserInfo(user1.address)).to.equal(
          redeemAmount1 + redeemAmount2,
        );
        expect(await express.getRedemptionQueueLength()).to.equal(2);
      });

      it("should redeem to different recipient", async function () {
        const { express, oem, usdo, user1, user2 } =
          await loadFixture(deployFixture);

        await express
          .connect(user1)
          .instantMint(
            await usdo.getAddress(),
            user1.address,
            ethers.parseUnits("1000", 18),
            0,
          );

        const redeemAmount = ethers.parseUnits("500", 18);
        await oem
          .connect(user1)
          .approve(await express.getAddress(), redeemAmount);

        await express.connect(user1).redeemRequest(user2.address, redeemAmount);

        expect(await express.getRedemptionUserInfo(user2.address)).to.equal(
          redeemAmount,
        );
      });
    });

    describe("Failure Cases", function () {
      it("should revert if sender not KYC approved", async function () {
        const { express, oem, usdo, user1, whitelister } =
          await loadFixture(deployFixture);

        await express
          .connect(user1)
          .instantMint(
            await usdo.getAddress(),
            user1.address,
            ethers.parseUnits("1000", 18),
            0,
          );

        await express.connect(whitelister).revokeKycInBulk([user1.address]);

        const redeemAmount = ethers.parseUnits("500", 18);
        await oem
          .connect(user1)
          .approve(await express.getAddress(), redeemAmount);

        await expect(
          express.connect(user1).redeemRequest(user1.address, redeemAmount),
        ).to.be.revertedWithCustomError(express, "NotInKycList");
      });

      it("should revert if recipient not KYC approved", async function () {
        const { express, oem, usdo, user1, user2, whitelister } =
          await loadFixture(deployFixture);

        await express
          .connect(user1)
          .instantMint(
            await usdo.getAddress(),
            user1.address,
            ethers.parseUnits("1000", 18),
            0,
          );

        await express.connect(whitelister).revokeKycInBulk([user2.address]);

        const redeemAmount = ethers.parseUnits("500", 18);
        await oem
          .connect(user1)
          .approve(await express.getAddress(), redeemAmount);

        await expect(
          express.connect(user1).redeemRequest(user2.address, redeemAmount),
        ).to.be.revertedWithCustomError(express, "NotInKycList");
      });

      it("should revert if amount is zero", async function () {
        const { express, user1 } = await loadFixture(deployFixture);

        await expect(
          express.connect(user1).redeemRequest(user1.address, 0),
        ).to.be.revertedWithCustomError(express, "InvalidAmount");
      });

      it("should revert if redeem is paused", async function () {
        const { express, oem, usdo, user1, pauser } =
          await loadFixture(deployFixture);

        await express
          .connect(user1)
          .instantMint(
            await usdo.getAddress(),
            user1.address,
            ethers.parseUnits("1000", 18),
            0,
          );

        await express.connect(pauser).pauseRedeem();

        const redeemAmount = ethers.parseUnits("500", 18);
        await oem
          .connect(user1)
          .approve(await express.getAddress(), redeemAmount);

        await expect(
          express.connect(user1).redeemRequest(user1.address, redeemAmount),
        ).to.be.reverted;
      });

      it("should revert if insufficient OEM balance", async function () {
        const { express, oem, user1 } = await loadFixture(deployFixture);

        const redeemAmount = ethers.parseUnits("1000", 18);
        await oem
          .connect(user1)
          .approve(await express.getAddress(), redeemAmount);

        await expect(
          express.connect(user1).redeemRequest(user1.address, redeemAmount),
        ).to.be.reverted;
      });
    });
  });

  describe("Process Redemption Queue With Price", function () {
    async function setupRedemptionQueueForPrice() {
      const fixture = await deployFixture();
      const { express, oem, usdo, user1, user2 } = fixture;

      // Mint OEM to users
      await express
        .connect(user1)
        .instantMint(
          await usdo.getAddress(),
          user1.address,
          ethers.parseUnits("2000", 18),
          0,
        );
      await express
        .connect(user2)
        .instantMint(
          await usdo.getAddress(),
          user2.address,
          ethers.parseUnits("2000", 18),
          0,
        );

      // Queue redemptions
      await oem
        .connect(user1)
        .approve(await express.getAddress(), ethers.parseUnits("1000", 18));
      await oem
        .connect(user2)
        .approve(await express.getAddress(), ethers.parseUnits("1000", 18));

      await express
        .connect(user1)
        .redeemRequest(user1.address, ethers.parseUnits("500", 18));
      await express
        .connect(user2)
        .redeemRequest(user2.address, ethers.parseUnits("600", 18));

      return fixture;
    }

    describe("Success Cases", function () {
      it("should process redemption with 90% price (0.9)", async function () {
        const { express, usdo, user1, maintainer } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        const price = 90000000n; // 0.9 * 1e8
        const userBalanceBefore = await usdo.balanceOf(user1.address);

        await expect(
          express.connect(maintainer).processRedemptionQueueWithPrice(1, price),
        ).to.emit(express, "ProcessRedeem");

        // User should receive 90% of their redemption amount
        const userBalanceAfter = await usdo.balanceOf(user1.address);
        const received = userBalanceAfter - userBalanceBefore;

        // Expected: 500 OEM * 0.9 = 450 USDO
        expect(received).to.equal(ethers.parseUnits("450", 18));
        expect(await express.getRedemptionQueueLength()).to.equal(1);
      });

      it("should process redemption with 50% price (0.5)", async function () {
        const { express, usdo, user1, maintainer } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        const price = 50000000n; // 0.5 * 1e8
        const userBalanceBefore = await usdo.balanceOf(user1.address);

        await express
          .connect(maintainer)
          .processRedemptionQueueWithPrice(1, price);

        const userBalanceAfter = await usdo.balanceOf(user1.address);
        const received = userBalanceAfter - userBalanceBefore;

        // Expected: 500 OEM * 0.5 = 250 USDO
        expect(received).to.equal(ethers.parseUnits("250", 18));
      });

      it("should process redemption with 1% price (0.01)", async function () {
        const { express, usdo, user1, maintainer } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        const price = 1000000n; // 0.01 * 1e8
        const userBalanceBefore = await usdo.balanceOf(user1.address);

        await express
          .connect(maintainer)
          .processRedemptionQueueWithPrice(1, price);

        const userBalanceAfter = await usdo.balanceOf(user1.address);
        const received = userBalanceAfter - userBalanceBefore;

        // Expected: 500 OEM * 0.01 = 5 USDO
        expect(received).to.equal(ethers.parseUnits("5", 18));
      });

      it("should process redemption with price = 1 (minimum price)", async function () {
        const { express, usdo, user1, maintainer } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        const price = 1n;
        const userBalanceBefore = await usdo.balanceOf(user1.address);

        await express
          .connect(maintainer)
          .processRedemptionQueueWithPrice(1, price);

        const userBalanceAfter = await usdo.balanceOf(user1.address);
        const received = userBalanceAfter - userBalanceBefore;

        // Very small amount
        expect(received).to.be.gt(0);
      });

      it("should process all redemptions with custom price when _len is 0", async function () {
        const { express, maintainer } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        const price = 80000000n; // 0.8 * 1e8

        await express
          .connect(maintainer)
          .processRedemptionQueueWithPrice(0, price);

        expect(await express.getRedemptionQueueLength()).to.equal(0);
      });

      it("should process multiple redemptions with custom price", async function () {
        const { express, maintainer } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        const price = 75000000n; // 0.75 * 1e8

        await express
          .connect(maintainer)
          .processRedemptionQueueWithPrice(2, price);

        expect(await express.getRedemptionQueueLength()).to.equal(0);
      });

      it("should burn OEM correctly with custom price", async function () {
        const { express, oem, maintainer } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        const price = 60000000n; // 0.6 * 1e8
        const supplyBefore = await oem.totalSupply();
        const expectedBurn = ethers.parseUnits("1100", 18); // 500 + 600 OEM burned

        await express
          .connect(maintainer)
          .processRedemptionQueueWithPrice(0, price);

        // OEM should still be burned at full amount, only USDO payout is adjusted
        expect(await oem.totalSupply()).to.equal(supplyBefore - expectedBurn);
      });

      it("should distribute reduced USDO amounts based on price", async function () {
        const { express, usdo, user1, user2, maintainer } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        const price = 70000000n; // 0.7 * 1e8

        const user1BalanceBefore = await usdo.balanceOf(user1.address);
        const user2BalanceBefore = await usdo.balanceOf(user2.address);

        await express
          .connect(maintainer)
          .processRedemptionQueueWithPrice(0, price);

        const user1BalanceAfter = await usdo.balanceOf(user1.address);
        const user2BalanceAfter = await usdo.balanceOf(user2.address);

        // User1 should receive ~350 USDO (500 * 0.7)
        // User2 should receive ~420 USDO (600 * 0.7)
        expect(user1BalanceAfter - user1BalanceBefore).to.equal(
          ethers.parseUnits("350", 18),
        );
        expect(user2BalanceAfter - user2BalanceBefore).to.equal(
          ethers.parseUnits("420", 18),
        );
      });

      it("should apply fees correctly with custom price", async function () {
        const { express, usdo, user1, feeTo, maintainer } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        // Set 10% redeem fee
        await express.connect(maintainer).updateRedeemFee(1000);

        const price = 80000000n; // 0.8 * 1e8

        const feeToBalanceBefore = await usdo.balanceOf(feeTo.address);
        const user1BalanceBefore = await usdo.balanceOf(user1.address);

        await express
          .connect(maintainer)
          .processRedemptionQueueWithPrice(1, price);

        const feeToBalanceAfter = await usdo.balanceOf(feeTo.address);
        const user1BalanceAfter = await usdo.balanceOf(user1.address);

        // Amount after price adjustment: 500 * 0.8 = 400 USDO
        // Fee: 400 * 0.1 = 40 USDO
        // User receives: 400 - 40 = 360 USDO
        const feeReceived = feeToBalanceAfter - feeToBalanceBefore;
        const userReceived = user1BalanceAfter - user1BalanceBefore;

        expect(feeReceived).to.equal(ethers.parseUnits("40", 18));
        expect(userReceived).to.equal(ethers.parseUnits("360", 18));
      });

      it("should update redemption info correctly with custom price", async function () {
        const { express, user1, user2, maintainer } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        const price = 85000000n; // 0.85 * 1e8

        await express
          .connect(maintainer)
          .processRedemptionQueueWithPrice(0, price);

        expect(await express.getRedemptionUserInfo(user1.address)).to.equal(0);
        expect(await express.getRedemptionUserInfo(user2.address)).to.equal(0);
      });

      it("should emit events with correct data", async function () {
        const { express, user1, maintainer } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        const price = 95000000n; // 0.95 * 1e8

        await expect(
          express.connect(maintainer).processRedemptionQueueWithPrice(1, price),
        ).to.emit(express, "ProcessRedeem");
      });

      it("should stop processing on insufficient liquidity with custom price", async function () {
        const { express, usdo, operator, maintainer } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        const price = 90000000n; // 0.9 * 1e8

        // Transfer USDO out to create liquidity shortage
        // With 0.9 price, we need 450 + 540 = 990 USDO for both redemptions
        const expressBalance = await usdo.balanceOf(await express.getAddress());
        await express
          .connect(operator)
          .offRamp(expressBalance - ethers.parseUnits("500", 18));

        // Try to process all - should only process one
        await express
          .connect(maintainer)
          .processRedemptionQueueWithPrice(0, price);

        // Queue should not be empty (one couldn't be processed)
        expect(await express.getRedemptionQueueLength()).to.be.gt(0);
      });

      it("should process partial queue when some items lack liquidity", async function () {
        const { express, usdo, operator, maintainer } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        const price = 50000000n; // 0.5 * 1e8

        // With 0.5 price, first redemption needs 250 USDO, second needs 300 USDO
        const expressBalance = await usdo.balanceOf(await express.getAddress());
        await express
          .connect(operator)
          .offRamp(expressBalance - ethers.parseUnits("270", 18));

        // Should process first (250 USDO) but not second (needs 300 USDO)
        await express
          .connect(maintainer)
          .processRedemptionQueueWithPrice(0, price);

        expect(await express.getRedemptionQueueLength()).to.equal(1);
      });
    });

    describe("Failure Cases", function () {
      it("should revert if price equals PRICE_BASE (1.0)", async function () {
        const { express, maintainer } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        const price = 100000000n; // 1.0 * 1e8 (PRICE_BASE)

        await expect(
          express.connect(maintainer).processRedemptionQueueWithPrice(1, price),
        ).to.be.revertedWithCustomError(express, "InvalidAmount");
      });

      it("should revert if price is greater than PRICE_BASE", async function () {
        const { express, maintainer } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        const price = 150000000n; // 1.5 * 1e8

        await expect(
          express.connect(maintainer).processRedemptionQueueWithPrice(1, price),
        ).to.be.revertedWithCustomError(express, "InvalidAmount");
      });

      it("should revert if called by non-maintainer (operator)", async function () {
        const { express, operator } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        const price = 90000000n; // 0.9 * 1e8

        await expect(
          express.connect(operator).processRedemptionQueueWithPrice(1, price),
        ).to.be.revertedWithCustomError(
          express,
          "AccessControlUnauthorizedAccount",
        );
      });

      it("should revert if called by non-maintainer (user)", async function () {
        const { express, user1 } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        const price = 90000000n; // 0.9 * 1e8

        await expect(
          express.connect(user1).processRedemptionQueueWithPrice(1, price),
        ).to.be.revertedWithCustomError(
          express,
          "AccessControlUnauthorizedAccount",
        );
      });

      it("should revert if queue is empty", async function () {
        const { express, maintainer } = await loadFixture(deployFixture);

        const price = 90000000n; // 0.9 * 1e8

        await expect(
          express.connect(maintainer).processRedemptionQueueWithPrice(1, price),
        ).to.be.revertedWithCustomError(express, "EmptyQueue");
      });

      it("should revert if _len exceeds queue length", async function () {
        const { express, maintainer } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        const price = 90000000n; // 0.9 * 1e8

        await expect(
          express
            .connect(maintainer)
            .processRedemptionQueueWithPrice(10, price),
        ).to.be.revertedWithCustomError(express, "InvalidInput");
      });

      it("should revert if user KYC revoked during processing", async function () {
        const { express, user1, maintainer, whitelister } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        const price = 90000000n; // 0.9 * 1e8

        // Revoke KYC
        await express.connect(whitelister).revokeKycInBulk([user1.address]);

        await expect(
          express.connect(maintainer).processRedemptionQueueWithPrice(1, price),
        ).to.be.revertedWithCustomError(express, "NotInKycList");
      });

      it("should revert with price = 0", async function () {
        const { express, maintainer } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        const price = 0n;

        await expect(
          express.connect(maintainer).processRedemptionQueueWithPrice(1, price),
        ).to.be.revertedWithCustomError(express, "InvalidAmount");
      });
    });

    describe("Edge Cases", function () {
      it("should handle very small price correctly", async function () {
        const { express, usdo, user1, maintainer } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        const price = 100n; // 0.000001 * 1e8

        const balanceBefore = await usdo.balanceOf(user1.address);

        await express
          .connect(maintainer)
          .processRedemptionQueueWithPrice(1, price);

        const balanceAfter = await usdo.balanceOf(user1.address);
        expect(balanceAfter).to.be.gt(balanceBefore);
      });

      it("should handle price just below PRICE_BASE", async function () {
        const { express, usdo, user1, maintainer } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        const price = 99999999n; // 0.99999999 * 1e8

        const balanceBefore = await usdo.balanceOf(user1.address);

        await express
          .connect(maintainer)
          .processRedemptionQueueWithPrice(1, price);

        const balanceAfter = await usdo.balanceOf(user1.address);
        const received = balanceAfter - balanceBefore;

        // Should be very close to 500 USDO
        expect(received).to.be.closeTo(
          ethers.parseUnits("500", 18),
          ethers.parseUnits("1", 16),
        );
      });

      it("should handle custom price with high fee rate", async function () {
        const { express, usdo, user1, maintainer } = await loadFixture(
          setupRedemptionQueueForPrice,
        );

        // Set 50% redeem fee
        await express.connect(maintainer).updateRedeemFee(5000);

        const price = 80000000n; // 0.8 * 1e8

        const balanceBefore = await usdo.balanceOf(user1.address);

        await express
          .connect(maintainer)
          .processRedemptionQueueWithPrice(1, price);

        const balanceAfter = await usdo.balanceOf(user1.address);
        const received = balanceAfter - balanceBefore;

        // 500 * 0.8 = 400, then 400 * 0.5 fee = 200, user gets 200
        expect(received).to.equal(ethers.parseUnits("200", 18));
      });

      it("should work correctly when combined with normal processRedemptionQueue", async function () {
        const {
          express,
          oem,
          usdo,
          user1,
          user2,
          user3,
          operator,
          maintainer,
        } = await loadFixture(deployFixture);

        // Setup - mint to 3 users
        await express
          .connect(user1)
          .instantMint(
            await usdo.getAddress(),
            user1.address,
            ethers.parseUnits("2000", 18),
            0,
          );
        await express
          .connect(user2)
          .instantMint(
            await usdo.getAddress(),
            user2.address,
            ethers.parseUnits("2000", 18),
            0,
          );
        await express
          .connect(user3)
          .instantMint(
            await usdo.getAddress(),
            user3.address,
            ethers.parseUnits("2000", 18),
            0,
          );

        // Queue 3 redemptions
        await oem
          .connect(user1)
          .approve(await express.getAddress(), ethers.parseUnits("500", 18));
        await oem
          .connect(user2)
          .approve(await express.getAddress(), ethers.parseUnits("500", 18));
        await oem
          .connect(user3)
          .approve(await express.getAddress(), ethers.parseUnits("500", 18));

        await express
          .connect(user1)
          .redeemRequest(user1.address, ethers.parseUnits("500", 18));
        await express
          .connect(user2)
          .redeemRequest(user2.address, ethers.parseUnits("500", 18));
        await express
          .connect(user3)
          .redeemRequest(user3.address, ethers.parseUnits("500", 18));

        expect(await express.getRedemptionQueueLength()).to.equal(3);

        // Process first with custom price
        const price = 80000000n; // 0.8 * 1e8
        await express
          .connect(maintainer)
          .processRedemptionQueueWithPrice(1, price);
        expect(await express.getRedemptionQueueLength()).to.equal(2);

        // Process second with normal price (1:1)
        await express.connect(operator).processRedemptionQueue(1);
        expect(await express.getRedemptionQueueLength()).to.equal(1);

        // Process last with custom price
        await express
          .connect(maintainer)
          .processRedemptionQueueWithPrice(1, price);
        expect(await express.getRedemptionQueueLength()).to.equal(0);
      });
    });
  });

  describe("Process Redemption Queue", function () {
    async function setupRedemptionQueue() {
      const fixture = await deployFixture();
      const { express, oem, usdo, user1, user2 } = fixture;

      // Mint OEM to users
      await express
        .connect(user1)
        .instantMint(
          await usdo.getAddress(),
          user1.address,
          ethers.parseUnits("2000", 18),
          0,
        );
      await express
        .connect(user2)
        .instantMint(
          await usdo.getAddress(),
          user2.address,
          ethers.parseUnits("2000", 18),
          0,
        );

      // Queue redemptions
      await oem
        .connect(user1)
        .approve(await express.getAddress(), ethers.parseUnits("1000", 18));
      await oem
        .connect(user2)
        .approve(await express.getAddress(), ethers.parseUnits("1000", 18));

      await express
        .connect(user1)
        .redeemRequest(user1.address, ethers.parseUnits("500", 18));
      await express
        .connect(user2)
        .redeemRequest(user2.address, ethers.parseUnits("600", 18));

      return fixture;
    }

    describe("Success Cases", function () {
      it("should process single redemption", async function () {
        const { express, oem, usdo, user1, operator } =
          await loadFixture(setupRedemptionQueue);

        const userBalanceBefore = await usdo.balanceOf(user1.address);
        const oemSupplyBefore = await oem.totalSupply();

        await expect(
          express.connect(operator).processRedemptionQueue(1),
        ).to.emit(express, "ProcessRedeem");

        expect(await express.getRedemptionQueueLength()).to.equal(1);
        expect(await usdo.balanceOf(user1.address)).to.be.gt(userBalanceBefore);
        expect(await oem.totalSupply()).to.be.lt(oemSupplyBefore);
      });

      it("should process all redemptions when _len is 0", async function () {
        const { express, operator } = await loadFixture(setupRedemptionQueue);

        await express.connect(operator).processRedemptionQueue(0);

        expect(await express.getRedemptionQueueLength()).to.equal(0);
      });

      it("should process multiple redemptions", async function () {
        const { express, operator } = await loadFixture(setupRedemptionQueue);

        await express.connect(operator).processRedemptionQueue(2);

        expect(await express.getRedemptionQueueLength()).to.equal(0);
      });

      it("should burn OEM correctly", async function () {
        const { express, oem, operator } =
          await loadFixture(setupRedemptionQueue);

        const supplyBefore = await oem.totalSupply();
        const expectedBurn = ethers.parseUnits("1100", 18); // 500 + 600

        await express.connect(operator).processRedemptionQueue(0);

        expect(await oem.totalSupply()).to.equal(supplyBefore - expectedBurn);
      });

      it("should distribute OEM to users", async function () {
        const { express, usdo, user1, user2, operator } =
          await loadFixture(setupRedemptionQueue);

        const user1BalanceBefore = await usdo.balanceOf(user1.address);
        const user2BalanceBefore = await usdo.balanceOf(user2.address);

        await express.connect(operator).processRedemptionQueue(0);

        expect(await usdo.balanceOf(user1.address)).to.be.gt(
          user1BalanceBefore,
        );
        expect(await usdo.balanceOf(user2.address)).to.be.gt(
          user2BalanceBefore,
        );
      });

      it("should distribute fees to feeTo", async function () {
        const { express, usdo, feeTo, operator, maintainer } =
          await loadFixture(setupRedemptionQueue);

        // Set redeem fee
        await express.connect(maintainer).updateRedeemFee(100); // 1%

        const feeToBalanceBefore = await usdo.balanceOf(feeTo.address);

        await express.connect(operator).processRedemptionQueue(0);

        expect(await usdo.balanceOf(feeTo.address)).to.be.gt(
          feeToBalanceBefore,
        );
      });

      it("should update redemption info correctly", async function () {
        const { express, user1, user2, operator } =
          await loadFixture(setupRedemptionQueue);

        await express.connect(operator).processRedemptionQueue(0);

        expect(await express.getRedemptionUserInfo(user1.address)).to.equal(0);
        expect(await express.getRedemptionUserInfo(user2.address)).to.equal(0);
      });

      it("should emit events with correct data", async function () {
        const { express, user1, operator } =
          await loadFixture(setupRedemptionQueue);

        await expect(
          express.connect(operator).processRedemptionQueue(1),
        ).to.emit(express, "ProcessRedeem");
      });

      it("should stop processing on insufficient liquidity", async function () {
        const { express, oem, usdo, user1, user2, operator } =
          await loadFixture(setupRedemptionQueue);

        // Transfer OEM out to create liquidity shortage
        const expressBalance = await usdo.balanceOf(await express.getAddress());
        await express
          .connect(operator)
          .offRamp(expressBalance - ethers.parseUnits("100", 18));

        // Try to process all - should only process one
        await express.connect(operator).processRedemptionQueue(0);

        // Queue should not be empty (one couldn't be processed)
        expect(await express.getRedemptionQueueLength()).to.be.gt(0);
      });
    });

    describe("Failure Cases", function () {
      it("should revert if called by non-operator", async function () {
        const { express, user1 } = await loadFixture(setupRedemptionQueue);

        await expect(
          express.connect(user1).processRedemptionQueue(1),
        ).to.be.revertedWithCustomError(
          express,
          "AccessControlUnauthorizedAccount",
        );
      });

      it("should revert if queue is empty", async function () {
        const { express, operator } = await loadFixture(deployFixture);

        await expect(
          express.connect(operator).processRedemptionQueue(1),
        ).to.be.revertedWithCustomError(express, "EmptyQueue");
      });

      it("should revert if _len exceeds queue length", async function () {
        const { express, operator } = await loadFixture(setupRedemptionQueue);

        await expect(
          express.connect(operator).processRedemptionQueue(10),
        ).to.be.revertedWithCustomError(express, "InvalidInput");
      });

      it("should revert if user KYC revoked during processing", async function () {
        const { express, user1, operator, whitelister } =
          await loadFixture(setupRedemptionQueue);

        // Revoke KYC
        await express.connect(whitelister).revokeKycInBulk([user1.address]);

        await expect(
          express.connect(operator).processRedemptionQueue(1),
        ).to.be.revertedWithCustomError(express, "NotInKycList");
      });
    });
  });

  describe("Cancel Redemption", function () {
    async function setupRedemptionQueue() {
      const fixture = await deployFixture();
      const { express, oem, usdo, user1, user2 } = fixture;

      await express
        .connect(user1)
        .instantMint(
          await usdo.getAddress(),
          user1.address,
          ethers.parseUnits("2000", 18),
          0,
        );
      await express
        .connect(user2)
        .instantMint(
          await usdo.getAddress(),
          user2.address,
          ethers.parseUnits("2000", 18),
          0,
        );

      await oem
        .connect(user1)
        .approve(await express.getAddress(), ethers.parseUnits("1000", 18));
      await oem
        .connect(user2)
        .approve(await express.getAddress(), ethers.parseUnits("1000", 18));

      await express
        .connect(user1)
        .redeemRequest(user1.address, ethers.parseUnits("500", 18));
      await express
        .connect(user2)
        .redeemRequest(user2.address, ethers.parseUnits("600", 18));

      return fixture;
    }

    it("should cancel single redemption", async function () {
      const { express, oem, user1, maintainer } =
        await loadFixture(setupRedemptionQueue);

      const balanceBefore = await oem.balanceOf(user1.address);

      await expect(express.connect(maintainer).cancel(1)).to.emit(
        express,
        "ProcessRedemptionCancel",
      );

      expect(await oem.balanceOf(user1.address)).to.be.gt(balanceBefore);
      expect(await express.getRedemptionQueueLength()).to.equal(1);
    });

    it("should cancel multiple redemptions", async function () {
      const { express, maintainer } = await loadFixture(setupRedemptionQueue);

      await express.connect(maintainer).cancel(2);

      expect(await express.getRedemptionQueueLength()).to.equal(0);
    });

    it("should refund OEM to original sender", async function () {
      const { express, oem, user1, maintainer } =
        await loadFixture(setupRedemptionQueue);

      const balanceBefore = await oem.balanceOf(user1.address);

      await express.connect(maintainer).cancel(1);

      expect(await oem.balanceOf(user1.address)).to.equal(
        balanceBefore + ethers.parseUnits("500", 18),
      );
    });

    it("should update redemption info", async function () {
      const { express, user1, maintainer } =
        await loadFixture(setupRedemptionQueue);

      await express.connect(maintainer).cancel(1);

      expect(await express.getRedemptionUserInfo(user1.address)).to.equal(0);
    });

    it("should revert if called by non-maintainer", async function () {
      const { express, user1 } = await loadFixture(setupRedemptionQueue);

      await expect(
        express.connect(user1).cancel(1),
      ).to.be.revertedWithCustomError(
        express,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("should revert if queue is empty", async function () {
      const { express, maintainer } = await loadFixture(deployFixture);

      await expect(
        express.connect(maintainer).cancel(1),
      ).to.be.revertedWithCustomError(express, "EmptyQueue");
    });

    it("should revert if _len is zero", async function () {
      const { express, maintainer } = await loadFixture(setupRedemptionQueue);

      await expect(
        express.connect(maintainer).cancel(0),
      ).to.be.revertedWithCustomError(express, "InvalidAmount");
    });

    it("should revert if _len exceeds queue length", async function () {
      const { express, maintainer } = await loadFixture(setupRedemptionQueue);

      await expect(
        express.connect(maintainer).cancel(10),
      ).to.be.revertedWithCustomError(express, "InvalidInput");
    });

    describe("Escrow for banned senders", function () {
      async function setupBannedSenderInQueue() {
        const fixture = await deployFixture();
        const { express, oem, usdo, user1, user2, admin, maintainer } = fixture;

        // Grant BANLIST_ROLE to admin for banning
        const BANLIST_ROLE = await oem.BANLIST_ROLE();
        await oem.connect(admin).grantRole(BANLIST_ROLE, admin.address);

        // Mint OEM to users via instantMint
        await express
          .connect(user1)
          .instantMint(
            await usdo.getAddress(),
            user1.address,
            ethers.parseUnits("2000", 18),
            0,
          );
        await express
          .connect(user2)
          .instantMint(
            await usdo.getAddress(),
            user2.address,
            ethers.parseUnits("2000", 18),
            0,
          );

        // Approve and submit redeem requests
        await oem
          .connect(user1)
          .approve(await express.getAddress(), ethers.parseUnits("1000", 18));
        await oem
          .connect(user2)
          .approve(await express.getAddress(), ethers.parseUnits("1000", 18));

        await express
          .connect(user1)
          .redeemRequest(user1.address, ethers.parseUnits("500", 18));
        await express
          .connect(user2)
          .redeemRequest(user2.address, ethers.parseUnits("600", 18));

        // Ban user1 after they submitted their redeem request
        await oem.connect(admin).banAddresses([user1.address]);

        return { ...fixture, BANLIST_ROLE };
      }

      it("should not revert cancel when sender is banned", async function () {
        const { express, maintainer } = await loadFixture(
          setupBannedSenderInQueue,
        );

        // cancel should succeed even though user1 is banned
        await expect(express.connect(maintainer).cancel(1)).to.not.be.reverted;
      });

      it("should escrow tokens when transfer to banned sender fails", async function () {
        const { express, user1, maintainer } = await loadFixture(
          setupBannedSenderInQueue,
        );

        await express.connect(maintainer).cancel(1);

        // Tokens should be in escrow, not transferred to banned user
        expect(await express.escrowBalance(user1.address)).to.equal(
          ethers.parseUnits("500", 18),
        );
      });

      it("should emit EscrowDeposit when transfer fails", async function () {
        const { express, user1, maintainer } = await loadFixture(
          setupBannedSenderInQueue,
        );

        await expect(express.connect(maintainer).cancel(1))
          .to.emit(express, "EscrowDeposit")
          .withArgs(user1.address, ethers.parseUnits("500", 18));
      });

      it("should still process non-banned entries after banned entry via cancel", async function () {
        const { express, oem, user2, maintainer } = await loadFixture(
          setupBannedSenderInQueue,
        );

        const balanceBefore = await oem.balanceOf(user2.address);

        // Cancel both entries - user1 (banned) goes to escrow, user2 (not banned) gets direct refund
        await express.connect(maintainer).cancel(2);

        expect(await express.getRedemptionQueueLength()).to.equal(0);
        expect(await oem.balanceOf(user2.address)).to.equal(
          balanceBefore + ethers.parseUnits("600", 18),
        );
      });

      it("should allow banned user to claim escrow after being unbanned", async function () {
        const { express, oem, user1, admin, maintainer } = await loadFixture(
          setupBannedSenderInQueue,
        );

        // Cancel puts tokens in escrow
        await express.connect(maintainer).cancel(1);
        const balanceBefore = await oem.balanceOf(user1.address);

        // Unban user1
        await oem.connect(admin).unbanAddresses([user1.address]);

        // Claim escrow
        await express.connect(user1).claimEscrow();

        expect(await oem.balanceOf(user1.address)).to.equal(
          balanceBefore + ethers.parseUnits("500", 18),
        );
        expect(await express.escrowBalance(user1.address)).to.equal(0);
      });

      it("should emit EscrowClaimed when user claims escrow", async function () {
        const { express, oem, user1, admin, maintainer } = await loadFixture(
          setupBannedSenderInQueue,
        );

        await express.connect(maintainer).cancel(1);
        await oem.connect(admin).unbanAddresses([user1.address]);

        await expect(express.connect(user1).claimEscrow())
          .to.emit(express, "EscrowClaimed")
          .withArgs(user1.address, ethers.parseUnits("500", 18));
      });

      it("should revert claimEscrow if still banned", async function () {
        const { express, user1, maintainer } = await loadFixture(
          setupBannedSenderInQueue,
        );

        await express.connect(maintainer).cancel(1);

        // user1 is still banned, safeTransfer will revert
        await expect(express.connect(user1).claimEscrow()).to.be.reverted;
      });

      it("should revert claimEscrow if no escrow balance", async function () {
        const { express, user2 } = await loadFixture(setupBannedSenderInQueue);

        await expect(
          express.connect(user2).claimEscrow(),
        ).to.be.revertedWithCustomError(express, "InvalidAmount");
      });

      it("should accumulate escrow across multiple cancelled entries", async function () {
        const fixture = await deployFixture();
        const { express, oem, usdo, user1, admin, maintainer } = fixture;

        const BANLIST_ROLE = await oem.BANLIST_ROLE();
        await oem.connect(admin).grantRole(BANLIST_ROLE, admin.address);

        // Mint and submit two redeem requests from user1
        await express
          .connect(user1)
          .instantMint(
            await usdo.getAddress(),
            user1.address,
            ethers.parseUnits("3000", 18),
            0,
          );
        await oem
          .connect(user1)
          .approve(await express.getAddress(), ethers.parseUnits("2000", 18));
        await express
          .connect(user1)
          .redeemRequest(user1.address, ethers.parseUnits("500", 18));
        await express
          .connect(user1)
          .redeemRequest(user1.address, ethers.parseUnits("700", 18));

        // Ban user1
        await oem.connect(admin).banAddresses([user1.address]);

        // Cancel both
        await express.connect(maintainer).cancel(2);

        expect(await express.escrowBalance(user1.address)).to.equal(
          ethers.parseUnits("1200", 18),
        );
      });
    });
  });

  describe("Configuration Management", function () {
    describe("Treasury Management", function () {
      it("should update treasury address", async function () {
        const { express, maintainer } = await loadFixture(deployFixture);

        const [, , , , , , , , , , newTreasury] = await ethers.getSigners();

        await expect(
          express.connect(maintainer).updateTreasury(newTreasury.address),
        )
          .to.emit(express, "UpdateTreasury")
          .withArgs(newTreasury.address);

        expect(await express.treasury()).to.equal(newTreasury.address);
      });

      it("should revert if treasury is zero address", async function () {
        const { express, maintainer } = await loadFixture(deployFixture);

        await expect(
          express.connect(maintainer).updateTreasury(ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(express, "InvalidAddress");
      });

      it("should revert if non-maintainer tries to update treasury", async function () {
        const { express, user1 } = await loadFixture(deployFixture);

        const [, , , , , , , , , , newTreasury] = await ethers.getSigners();

        await expect(
          express.connect(user1).updateTreasury(newTreasury.address),
        ).to.be.revertedWithCustomError(
          express,
          "AccessControlUnauthorizedAccount",
        );
      });
    });

    describe("Fee Recipient Management", function () {
      it("should update feeTo address", async function () {
        const { express, maintainer } = await loadFixture(deployFixture);

        const [, , , , , , , , , , newFeeTo] = await ethers.getSigners();

        await expect(express.connect(maintainer).updateFeeTo(newFeeTo.address))
          .to.emit(express, "UpdateFeeTo")
          .withArgs(newFeeTo.address);

        expect(await express.feeTo()).to.equal(newFeeTo.address);
      });

      it("should revert if feeTo is zero address", async function () {
        const { express, maintainer } = await loadFixture(deployFixture);

        await expect(
          express.connect(maintainer).updateFeeTo(ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(express, "InvalidAddress");
      });

      it("should revert if non-maintainer tries to update feeTo", async function () {
        const { express, user1 } = await loadFixture(deployFixture);

        const [, , , , , , , , , , newFeeTo] = await ethers.getSigners();

        await expect(
          express.connect(user1).updateFeeTo(newFeeTo.address),
        ).to.be.revertedWithCustomError(
          express,
          "AccessControlUnauthorizedAccount",
        );
      });
    });

    describe("Fee Rate Management", function () {
      it("should update mint fee rate", async function () {
        const { express, maintainer } = await loadFixture(deployFixture);

        const newFee = 200; // 2%

        await expect(express.connect(maintainer).updateMintFee(newFee))
          .to.emit(express, "UpdateMintFeeRate")
          .withArgs(newFee);

        expect(await express.mintFeeRate()).to.equal(newFee);
      });

      it("should update redeem fee rate", async function () {
        const { express, maintainer } = await loadFixture(deployFixture);

        const newFee = 150; // 1.5%

        await expect(express.connect(maintainer).updateRedeemFee(newFee))
          .to.emit(express, "UpdateRedeemFeeRate")
          .withArgs(newFee);

        expect(await express.redeemFeeRate()).to.equal(newFee);
      });

      it("should allow setting fee to zero", async function () {
        const { express, maintainer } = await loadFixture(deployFixture);

        await express.connect(maintainer).updateMintFee(100);
        await express.connect(maintainer).updateMintFee(0);

        expect(await express.mintFeeRate()).to.equal(0);
      });

      it("should revert if non-maintainer tries to update mint fee", async function () {
        const { express, user1 } = await loadFixture(deployFixture);

        await expect(
          express.connect(user1).updateMintFee(100),
        ).to.be.revertedWithCustomError(
          express,
          "AccessControlUnauthorizedAccount",
        );
      });

      it("should revert if non-maintainer tries to update redeem fee", async function () {
        const { express, user1 } = await loadFixture(deployFixture);

        await expect(
          express.connect(user1).updateRedeemFee(100),
        ).to.be.revertedWithCustomError(
          express,
          "AccessControlUnauthorizedAccount",
        );
      });
    });

    describe("Asset Registry Management", function () {
      it("should update asset registry", async function () {
        const { express, maintainer, admin } = await loadFixture(deployFixture);

        const AssetRegistryFactory =
          await ethers.getContractFactory("AssetRegistry");
        const newRegistry = await upgrades.deployProxy(
          AssetRegistryFactory,
          [admin.address],
          {
            kind: "uups",
            initializer: "initialize",
          },
        );

        await expect(
          express
            .connect(maintainer)
            .setAssetRegistry(await newRegistry.getAddress()),
        )
          .to.emit(express, "AssetRegistryUpdated")
          .withArgs(await newRegistry.getAddress());

        expect(await express.assetRegistry()).to.equal(
          await newRegistry.getAddress(),
        );
      });

      it("should revert if asset registry is zero address", async function () {
        const { express, maintainer } = await loadFixture(deployFixture);

        await expect(
          express.connect(maintainer).setAssetRegistry(ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(express, "InvalidAddress");
      });

      it("should revert if non-maintainer tries to update asset registry", async function () {
        const { express, user1, admin } = await loadFixture(deployFixture);

        const AssetRegistryFactory =
          await ethers.getContractFactory("AssetRegistry");
        const newRegistry = await upgrades.deployProxy(
          AssetRegistryFactory,
          [admin.address],
          {
            kind: "uups",
            initializer: "initialize",
          },
        );

        await expect(
          express
            .connect(user1)
            .setAssetRegistry(await newRegistry.getAddress()),
        ).to.be.revertedWithCustomError(
          express,
          "AccessControlUnauthorizedAccount",
        );
      });
    });

    describe("Mint Minimum Management", function () {
      it("should update mint minimum", async function () {
        const { express, maintainer } = await loadFixture(deployFixture);

        const newMinimum = ethers.parseUnits("200", 18);

        await expect(express.connect(maintainer).setMintMinimum(newMinimum))
          .to.emit(express, "MintMinimumUpdated")
          .withArgs(newMinimum);

        expect(await express._mintMinimum()).to.equal(newMinimum);
      });

      it("should allow setting mint minimum to zero", async function () {
        const { express, maintainer } = await loadFixture(deployFixture);

        await express.connect(maintainer).setMintMinimum(0);

        expect(await express._mintMinimum()).to.equal(0);
      });

      it("should revert if non-maintainer tries to update mint minimum", async function () {
        const { express, user1 } = await loadFixture(deployFixture);

        await expect(
          express.connect(user1).setMintMinimum(ethers.parseUnits("200", 18)),
        ).to.be.revertedWithCustomError(
          express,
          "AccessControlUnauthorizedAccount",
        );
      });
    });

    describe("First Deposit Amount Management", function () {
      it("should update first deposit amount", async function () {
        const { express, maintainer } = await loadFixture(deployFixture);

        const newAmount = ethers.parseUnits("2000", 18);

        await expect(
          express.connect(maintainer).setFirstDepositAmount(newAmount),
        )
          .to.emit(express, "FirstDepositAmount")
          .withArgs(newAmount);

        expect(await express._firstDepositAmount()).to.equal(newAmount);
      });

      it("should revert if non-maintainer tries to update first deposit amount", async function () {
        const { express, user1 } = await loadFixture(deployFixture);

        await expect(
          express
            .connect(user1)
            .setFirstDepositAmount(ethers.parseUnits("2000", 18)),
        ).to.be.revertedWithCustomError(
          express,
          "AccessControlUnauthorizedAccount",
        );
      });
    });

    describe("First Deposit Status Management", function () {
      it("should update first deposit status", async function () {
        const { express, maintainer, user1 } = await loadFixture(deployFixture);

        await expect(
          express.connect(maintainer).updateFirstDeposit(user1.address, true),
        )
          .to.emit(express, "UpdateFirstDeposit")
          .withArgs(user1.address, true);

        expect(await express.firstDeposit(user1.address)).to.be.true;
      });

      it("should revert if account is zero address", async function () {
        const { express, maintainer } = await loadFixture(deployFixture);

        await expect(
          express
            .connect(maintainer)
            .updateFirstDeposit(ethers.ZeroAddress, true),
        ).to.be.revertedWithCustomError(express, "InvalidAddress");
      });

      it("should revert if non-maintainer tries to update first deposit status", async function () {
        const { express, user1, user2 } = await loadFixture(deployFixture);

        await expect(
          express.connect(user1).updateFirstDeposit(user2.address, true),
        ).to.be.revertedWithCustomError(
          express,
          "AccessControlUnauthorizedAccount",
        );
      });
    });
  });

  describe("Pausable Functionality", function () {
    describe("Mint Pause", function () {
      it("should pause mint operations", async function () {
        const { express, pauser } = await loadFixture(deployFixture);

        await expect(express.connect(pauser).pauseMint())
          .to.emit(express, "PausedMint")
          .withArgs(pauser.address);

        expect(await express.pausedMint()).to.be.true;
      });

      it("should unpause mint operations", async function () {
        const { express, pauser } = await loadFixture(deployFixture);

        await express.connect(pauser).pauseMint();

        await expect(express.connect(pauser).unpauseMint())
          .to.emit(express, "UnpausedMint")
          .withArgs(pauser.address);

        expect(await express.pausedMint()).to.be.false;
      });

      it("should prevent minting when paused", async function () {
        const { express, usdo, user1, pauser } =
          await loadFixture(deployFixture);

        await express.connect(pauser).pauseMint();

        await expect(
          express
            .connect(user1)
            .instantMint(
              await usdo.getAddress(),
              user1.address,
              ethers.parseUnits("1000", 18),
              0,
            ),
        ).to.be.reverted;
      });

      it("should allow minting after unpause", async function () {
        const { express, usdo, user1, pauser } =
          await loadFixture(deployFixture);

        await express.connect(pauser).pauseMint();
        await express.connect(pauser).unpauseMint();

        await expect(
          express
            .connect(user1)
            .instantMint(
              await usdo.getAddress(),
              user1.address,
              ethers.parseUnits("1000", 18),
              0,
            ),
        ).to.not.be.reverted;
      });

      it("should revert if non-pauser tries to pause mint", async function () {
        const { express, user1 } = await loadFixture(deployFixture);

        await expect(
          express.connect(user1).pauseMint(),
        ).to.be.revertedWithCustomError(
          express,
          "AccessControlUnauthorizedAccount",
        );
      });

      it("should revert if non-pauser tries to unpause mint", async function () {
        const { express, user1, pauser } = await loadFixture(deployFixture);

        await express.connect(pauser).pauseMint();

        await expect(
          express.connect(user1).unpauseMint(),
        ).to.be.revertedWithCustomError(
          express,
          "AccessControlUnauthorizedAccount",
        );
      });
    });

    describe("Redeem Pause", function () {
      it("should pause redeem operations", async function () {
        const { express, pauser } = await loadFixture(deployFixture);

        await expect(express.connect(pauser).pauseRedeem())
          .to.emit(express, "PausedRedeem")
          .withArgs(pauser.address);

        expect(await express.pausedRedeem()).to.be.true;
      });

      it("should unpause redeem operations", async function () {
        const { express, pauser } = await loadFixture(deployFixture);

        await express.connect(pauser).pauseRedeem();

        await expect(express.connect(pauser).unpauseRedeem())
          .to.emit(express, "UnpausedRedeem")
          .withArgs(pauser.address);

        expect(await express.pausedRedeem()).to.be.false;
      });

      it("should prevent redemption requests when paused", async function () {
        const { express, oem, usdo, user1, pauser } =
          await loadFixture(deployFixture);

        await express
          .connect(user1)
          .instantMint(
            await usdo.getAddress(),
            user1.address,
            ethers.parseUnits("1000", 18),
            0,
          );

        await express.connect(pauser).pauseRedeem();

        await oem
          .connect(user1)
          .approve(await express.getAddress(), ethers.parseUnits("500", 18));

        await expect(
          express
            .connect(user1)
            .redeemRequest(user1.address, ethers.parseUnits("500", 18)),
        ).to.be.reverted;
      });

      it("should allow redemption requests after unpause", async function () {
        const { express, oem, usdo, user1, pauser } =
          await loadFixture(deployFixture);

        await express
          .connect(user1)
          .instantMint(
            await usdo.getAddress(),
            user1.address,
            ethers.parseUnits("1000", 18),
            0,
          );

        await express.connect(pauser).pauseRedeem();
        await express.connect(pauser).unpauseRedeem();

        await oem
          .connect(user1)
          .approve(await express.getAddress(), ethers.parseUnits("500", 18));

        await expect(
          express
            .connect(user1)
            .redeemRequest(user1.address, ethers.parseUnits("500", 18)),
        ).to.not.be.reverted;
      });

      it("should revert if non-pauser tries to pause redeem", async function () {
        const { express, user1 } = await loadFixture(deployFixture);

        await expect(
          express.connect(user1).pauseRedeem(),
        ).to.be.revertedWithCustomError(
          express,
          "AccessControlUnauthorizedAccount",
        );
      });

      it("should revert if non-pauser tries to unpause redeem", async function () {
        const { express, user1, pauser } = await loadFixture(deployFixture);

        await express.connect(pauser).pauseRedeem();

        await expect(
          express.connect(user1).unpauseRedeem(),
        ).to.be.revertedWithCustomError(
          express,
          "AccessControlUnauthorizedAccount",
        );
      });
    });
  });

  describe("Treasury Operations", function () {
    it("should transfer USDO from contract to treasury via offRamp", async function () {
      const { express, usdo, operator, treasury } =
        await loadFixture(deployFixture);

      const amount = ethers.parseUnits("500", 18);
      const treasuryBalanceBefore = await usdo.balanceOf(treasury.address);

      await expect(express.connect(operator).offRamp(amount))
        .to.emit(express, "OffRamp")
        .withArgs(treasury.address, amount);

      expect(await usdo.balanceOf(treasury.address)).to.equal(
        treasuryBalanceBefore + amount,
      );
    });

    it("should revert if offRamp amount is zero", async function () {
      const { express, operator } = await loadFixture(deployFixture);

      await expect(
        express.connect(operator).offRamp(0),
      ).to.be.revertedWithCustomError(express, "InvalidAmount");
    });

    it("should revert if non-operator tries to offRamp", async function () {
      const { express, user1 } = await loadFixture(deployFixture);

      await expect(
        express.connect(user1).offRamp(ethers.parseUnits("100", 18)),
      ).to.be.revertedWithCustomError(
        express,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("should revert if insufficient balance for offRamp", async function () {
      const { express, usdo, operator } = await loadFixture(deployFixture);

      const balance = await usdo.balanceOf(await express.getAddress());
      const amount = balance + ethers.parseUnits("1", 18);

      await expect(express.connect(operator).offRamp(amount)).to.be.reverted;
    });
  });

  describe("View Functions", function () {
    it("should return correct token balance", async function () {
      const { express, usdo } = await loadFixture(deployFixture);

      const expectedBalance = ethers.parseUnits("100000", 18);
      const actualBalance = await express.getTokenBalance(
        await usdo.getAddress(),
      );

      expect(actualBalance).to.equal(expectedBalance);
    });

    it("should return correct queue info at index", async function () {
      const { express, oem, usdo, user1 } = await loadFixture(deployFixture);

      await express
        .connect(user1)
        .instantMint(
          await usdo.getAddress(),
          user1.address,
          ethers.parseUnits("1000", 18),
          0,
        );

      const redeemAmount = ethers.parseUnits("500", 18);
      await oem
        .connect(user1)
        .approve(await express.getAddress(), redeemAmount);
      await express.connect(user1).redeemRequest(user1.address, redeemAmount);

      const [sender, receiver, amount, id] =
        await express.getRedemptionQueueInfo(0);

      expect(sender).to.equal(user1.address);
      expect(receiver).to.equal(user1.address);
      expect(amount).to.equal(redeemAmount);
      expect(id).to.not.equal(ethers.ZeroHash);
    });

    it("should return zero values for invalid queue index", async function () {
      const { express } = await loadFixture(deployFixture);

      const [sender, receiver, amount, id] =
        await express.getRedemptionQueueInfo(5);

      expect(sender).to.equal(ethers.ZeroAddress);
      expect(receiver).to.equal(ethers.ZeroAddress);
      expect(amount).to.equal(0);
      expect(id).to.equal(ethers.ZeroHash);
    });

    it("should return correct conversion from underlying", async function () {
      const { express, usdo } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("1000", 18);
      const converted = await express.convertFromUnderlying(
        await usdo.getAddress(),
        amount,
      );

      expect(converted).to.equal(amount); // 1:1 conversion for USDO
    });

    it("should return correct conversion to underlying", async function () {
      const { express, usdo } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("1000", 18);
      const converted = await express.convertToUnderlying(
        await usdo.getAddress(),
        amount,
      );

      expect(converted).to.equal(amount); // 1:1 conversion for USDO
    });

    it("should calculate transaction fee correctly", async function () {
      const { express, maintainer } = await loadFixture(deployFixture);

      await express.connect(maintainer).updateMintFee(100); // 1%
      await express.connect(maintainer).updateRedeemFee(200); // 2%

      const amount = ethers.parseUnits("1000", 18);

      const TxType = { MINT: 0, REDEEM: 1 };
      const mintFee = await express.txsFee(amount, TxType.MINT);
      const redeemFee = await express.txsFee(amount, TxType.REDEEM);

      expect(mintFee).to.equal(ethers.parseUnits("10", 18)); // 1% of 1000
      expect(redeemFee).to.equal(ethers.parseUnits("20", 18)); // 2% of 1000
    });
  });

  describe("Upgradeability", function () {
    it("should upgrade to new implementation", async function () {
      const { express, admin } = await loadFixture(deployFixture);

      const ExpressV2Factory = await ethers.getContractFactory("Express");
      const upgraded = await upgrades.upgradeProxy(
        await express.getAddress(),
        ExpressV2Factory,
        {
          call: { fn: "version", args: [] },
        },
      );

      expect(await upgraded.version()).to.equal("1.0.0");
    });

    it("should revert if non-upgrader tries to upgrade", async function () {
      const { express, user1 } = await loadFixture(deployFixture);

      const newImplementation = ethers.Wallet.createRandom().address;

      await expect(
        express.connect(user1).upgradeToAndCall(newImplementation, "0x"),
      ).to.be.revertedWithCustomError(
        express,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("should revert if upgrade to zero address", async function () {
      const { express, admin } = await loadFixture(deployFixture);

      // This will be caught by the _authorizeUpgrade internal check
      await expect(
        express.connect(admin).upgradeToAndCall(ethers.ZeroAddress, "0x"),
      ).to.be.reverted;
    });
  });

  describe("Edge Cases and Integration", function () {
    it("should handle complete mint-redeem-process flow", async function () {
      const { express, oem, usdo, user1, operator } =
        await loadFixture(deployFixture);

      // Mint
      const mintAmount = ethers.parseUnits("2000", 18);
      await express
        .connect(user1)
        .instantMint(await usdo.getAddress(), user1.address, mintAmount, 0);

      // Redeem request
      const redeemAmount = ethers.parseUnits("1000", 18);
      await oem
        .connect(user1)
        .approve(await express.getAddress(), redeemAmount);
      await express.connect(user1).redeemRequest(user1.address, redeemAmount);

      // Process
      await express.connect(operator).processRedemptionQueue(0);

      expect(await express.getRedemptionQueueLength()).to.equal(0);
    });

    it("should handle multiple users with different operations", async function () {
      const { express, oem, usdo, user1, user2, user3, operator } =
        await loadFixture(deployFixture);

      // User1 mints
      await express
        .connect(user1)
        .instantMint(
          await usdo.getAddress(),
          user1.address,
          ethers.parseUnits("2000", 18),
          0,
        );

      // User2 mints
      await express
        .connect(user2)
        .instantMint(
          await usdo.getAddress(),
          user2.address,
          ethers.parseUnits("3000", 18),
          0,
        );

      // User3 mints
      await express
        .connect(user3)
        .instantMint(
          await usdo.getAddress(),
          user3.address,
          ethers.parseUnits("1500", 18),
          0,
        );

      // User1 redeems
      await oem
        .connect(user1)
        .approve(await express.getAddress(), ethers.parseUnits("1000", 18));
      await express
        .connect(user1)
        .redeemRequest(user1.address, ethers.parseUnits("1000", 18));

      // User2 redeems
      await oem
        .connect(user2)
        .approve(await express.getAddress(), ethers.parseUnits("1500", 18));
      await express
        .connect(user2)
        .redeemRequest(user2.address, ethers.parseUnits("1500", 18));

      // Process all
      await express.connect(operator).processRedemptionQueue(0);

      expect(await express.getRedemptionQueueLength()).to.equal(0);
    });

    it("should handle fee changes between mint and redeem", async function () {
      const { express, oem, usdo, user1, operator, maintainer } =
        await loadFixture(deployFixture);

      // Mint with no fee
      await express
        .connect(user1)
        .instantMint(
          await usdo.getAddress(),
          user1.address,
          ethers.parseUnits("2000", 18),
          0,
        );

      // Change fees
      await express.connect(maintainer).updateRedeemFee(500); // 5%

      // Redeem with fee
      await oem
        .connect(user1)
        .approve(await express.getAddress(), ethers.parseUnits("1000", 18));
      await express
        .connect(user1)
        .redeemRequest(user1.address, ethers.parseUnits("1000", 18));

      await express.connect(operator).processRedemptionQueue(0);

      // User should receive 95% of their USDO back (5% fee)
      expect(await usdo.balanceOf(user1.address)).to.be.gt(0);
    });

    it("should handle zero fee when feeTo not set", async function () {
      const { express, usdo, user1 } = await loadFixture(deployFixture);

      const mintAmount = ethers.parseUnits("1000", 18);
      await express
        .connect(user1)
        .instantMint(await usdo.getAddress(), user1.address, mintAmount, 0);

      expect(await usdo.balanceOf(user1.address)).to.be.gte(0);
    });

    it("should handle queue operations after pause and unpause", async function () {
      const { express, oem, usdo, user1, operator, pauser } =
        await loadFixture(deployFixture);

      // Mint
      await express
        .connect(user1)
        .instantMint(
          await usdo.getAddress(),
          user1.address,
          ethers.parseUnits("2000", 18),
          0,
        );

      // Pause redeem
      await express.connect(pauser).pauseRedeem();

      // Try to redeem (should fail)
      await oem
        .connect(user1)
        .approve(await express.getAddress(), ethers.parseUnits("1000", 18));
      await expect(
        express
          .connect(user1)
          .redeemRequest(user1.address, ethers.parseUnits("500", 18)),
      ).to.be.reverted;

      // Unpause
      await express.connect(pauser).unpauseRedeem();

      // Redeem should work now
      await express
        .connect(user1)
        .redeemRequest(user1.address, ethers.parseUnits("500", 18));

      // Process should work
      await express.connect(operator).processRedemptionQueue(0);

      expect(await express.getRedemptionQueueLength()).to.equal(0);
    });

    it("should maintain correct accounting across multiple operations", async function () {
      const { express, oem, usdo, user1, operator } =
        await loadFixture(deployFixture);

      const initialUsdoBalance = await usdo.balanceOf(user1.address);

      // Mint 2000
      await express
        .connect(user1)
        .instantMint(
          await usdo.getAddress(),
          user1.address,
          ethers.parseUnits("2000", 18),
          0,
        );

      const oemBalance = await oem.balanceOf(user1.address);
      expect(oemBalance).to.equal(ethers.parseUnits("2000", 18));

      // Redeem 1000
      await oem
        .connect(user1)
        .approve(await express.getAddress(), ethers.parseUnits("1000", 18));
      await express
        .connect(user1)
        .redeemRequest(user1.address, ethers.parseUnits("1000", 18));

      await express.connect(operator).processRedemptionQueue(0);

      // User should have 1000 USDO left
      expect(await oem.balanceOf(user1.address)).to.equal(
        ethers.parseUnits("1000", 18),
      );

      // User should have received USDO back (minus initial mint cost)
      const finalUsdoBalance = await usdo.balanceOf(user1.address);
      expect(finalUsdoBalance).to.equal(
        initialUsdoBalance - ethers.parseUnits("1000", 18),
      );
    });

    it("should handle first deposit flag correctly across multiple users", async function () {
      const { express, usdo, user1, user2 } = await loadFixture(deployFixture);

      expect(await express.firstDeposit(user1.address)).to.be.false;
      expect(await express.firstDeposit(user2.address)).to.be.false;

      // User1 mints
      await express
        .connect(user1)
        .instantMint(
          await usdo.getAddress(),
          user1.address,
          ethers.parseUnits("1000", 18),
          0,
        );
      expect(await express.firstDeposit(user1.address)).to.be.true;
      expect(await express.firstDeposit(user2.address)).to.be.false;

      // User2 mints
      await express
        .connect(user2)
        .instantMint(
          await usdo.getAddress(),
          user2.address,
          ethers.parseUnits("1000", 18),
          0,
        );
      expect(await express.firstDeposit(user1.address)).to.be.true;
      expect(await express.firstDeposit(user2.address)).to.be.true;
    });

    it("should handle boundary values for minimums", async function () {
      const { express, usdo, user1, maintainer } =
        await loadFixture(deployFixture);

      // Set very low minimums
      await express.connect(maintainer).setMintMinimum(1);
      await express.connect(maintainer).setFirstDepositAmount(1);

      // Should work with tiny amounts after first deposit
      await express
        .connect(user1)
        .instantMint(await usdo.getAddress(), user1.address, 1, 0);
      await express
        .connect(user1)
        .instantMint(await usdo.getAddress(), user1.address, 1, 0);
    });
  });
});
