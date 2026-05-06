# Prism Direct Redeem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `requestDirectRedeem` to Prism's `contracts/extension/Express.sol` — burn PRISM tokens immediately and emit an `OffchainRedeem` event the back-office DB matches against to pay out in arbitrary assets (e.g. RLUSD).

**Architecture:** Single new external function on `Express.sol`. Validates KYC + pause + asset guards, calls `token.burn(from, _amount)` directly (Express has BURNER_ROLE), emits an event with `(from, to, asset, tokenAmount)`. No queue, no fee, no escrow, no new state.

**Tech Stack:** Solidity, Hardhat, ethers v6, TypeChain, Chai, hardhat-network-helpers, OpenZeppelin v5 upgradeable.

**Spec:** `docs/superpowers/specs/2026-05-06-direct-redeem-design.md`

**Branch:** `wp/direct-redeem` (already created, spec already committed).

---

## Pre-Verified Facts

These details were inspected before writing the plan; the implementer can rely on them:

- **Existing errors in `Express.sol`** (line 150-157): `InvalidAddress`, `InvalidAmount`, `InvalidInput`, `NotInKycList`, `InsufficientOutput`, `MintLessThanMinimum`, `FirstDepositLessThanRequired`, `EmptyQueue`. **Reuse `InvalidAddress` and `InvalidAmount`. Add `UnderlyingNotAllowed` as the only new error.**
- **Pause guard:** `ExpressPausable` uses `require()` with string messages, NOT custom errors. The redeem-paused message is exactly `"Pausable: Redeem paused"`. Tests must use `.to.be.revertedWith('Pausable: Redeem paused')`, NOT `.revertedWithCustomError`.
- **KYC API:** `express.connect(whitelister).grantKycInBulk([addrs])` and `express.connect(whitelister).revokeKycInBulk([addrs])`. Whitelister signer is in the fixture.
- **Existing redeem function name:** `redeemRequest(address _to, uint256 _amount)` (no asset parameter — single `underlying`).
- **Token burn:** `token.burn(address from, uint256 amount)` is gated by `BURNER_ROLE`; Express already holds it (granted in fixture).
- **Fixture:** `test/fixtures/expressDeployments.ts` exports `deployExpressContracts()` returning `{ oem, usdo, express, assetRegistry, admin, operator, maintainer, whitelister, pauser, treasury, feeTo, user1, user2, user3 }`. Token contract is named `Token` but exported as `oem` in the fixture (legacy naming — keep it).
- **`underlying` field:** `address public underlying;` set from constructor's `_underlying` (the redeem asset, e.g. USDO).
- **`instantMint` signature:** `instantMint(address _asset, address _to, uint256 _amount, uint256 _minMintOut)`.
- **`redeemRequest` enqueues** to `redemptionQueue`; processing burns and pays out.

---

## File Structure

- **Modify:** `contracts/extension/Express.sol`
  - Add new error `UnderlyingNotAllowed()` to errors block.
  - Add new event `OffchainRedeem` near other events.
  - Add new function `requestDirectRedeem` immediately after `redeemRequest` (around line 412).
- **Create:** `test/unit/Express.directRedeem.test.ts` (new file using `deployExpressContracts` fixture).
- **Modify:** `CLAUDE.md`
  - Add a paragraph describing the new third redeem path.

No new state variables, no new roles, no new constants. Storage layout untouched.

---

## Task 1: Add error and event declarations

**Files:**
- Modify: `contracts/extension/Express.sol` (errors block around line 157, events block — find the existing `event AddToRedemptionQueue` and add `OffchainRedeem` near it)

- [ ] **Step 1: Add the new error**

In `contracts/extension/Express.sol`, locate the errors block. After `error EmptyQueue();` (line 157), add:

```solidity
    error UnderlyingNotAllowed();
```

- [ ] **Step 2: Add the new event**

In the events block (find `event AddToRedemptionQueue` — it's near line 100), add the new event immediately after it:

```solidity
    // Event for off-chain redeem (direct burn, off-chain settlement in arbitrary asset)
    event OffchainRedeem(
        address indexed from,
        address indexed to,
        address indexed asset,
        uint256 tokenAmount
    );
```

- [ ] **Step 3: Compile**

Run: `npm run compile`
Expected: clean build, "Compiled X Solidity files successfully".

- [ ] **Step 4: Commit**

```bash
git add contracts/extension/Express.sol
git commit -m "feat(express): add OffchainRedeem event and UnderlyingNotAllowed error"
```

---

## Task 2: Add failing happy-path test

**Files:**
- Create: `test/unit/Express.directRedeem.test.ts`

- [ ] **Step 1: Create the test file with one happy-path test**

Write the following file at `test/unit/Express.directRedeem.test.ts`:

```typescript
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

    // Approve PRISM token spend (not strictly needed for direct burn, but
    // matches existing test conventions for redeem flows).
    await oem
      .connect(user1)
      .approve(await express.getAddress(), ethers.MaxUint256);
    await oem
      .connect(user2)
      .approve(await express.getAddress(), ethers.MaxUint256);

    return fixture;
  }

  // Arbitrary "RLUSD" address — informational only; contract never calls it.
  // Use ethers.getAddress to normalize EIP-55 checksum (ethers v6 strict-checks).
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx hardhat test test/unit/Express.directRedeem.test.ts`
Expected: FAIL — `TypeError: express.connect(...).requestDirectRedeem is not a function` (or a TypeChain error about an unknown method).

- [ ] **Step 3: Commit the failing test**

```bash
git add test/unit/Express.directRedeem.test.ts
git commit -m "test(express): failing happy-path test for requestDirectRedeem"
```

---

## Task 3: Implement `requestDirectRedeem`

**Files:**
- Modify: `contracts/extension/Express.sol` (insert immediately after `redeemRequest`'s closing brace, around line 412)

- [ ] **Step 1: Add the function**

Locate the `redeemRequest` function (starts around line 386, ends around line 412 with the `emit AddToRedemptionQueue(...)` and closing brace). Immediately after its closing brace, insert:

```solidity
    /**
     * @notice Redeem PRISM tokens with off-chain settlement in an arbitrary asset.
     * @dev Burns tokens immediately. The settlement payout is handled fully off-chain;
     *      the contract only emits the burn record for the DB to match against.
     *      No queue, no on-chain fee, no T+N delay; fees are applied off-chain at
     *      settlement time. Express must hold BURNER_ROLE on the Token contract.
     * @param _asset Informational asset address the user wants to receive off-chain
     *               (e.g. RLUSD). Must be non-zero and not equal to underlying.
     * @param _amount PRISM token amount to burn.
     * @param _to KYC'd recipient address recorded for off-chain settlement.
     */
    function requestDirectRedeem(
        address _asset,
        uint256 _amount,
        address _to
    ) external whenNotPausedRedeem {
        address from = _msgSender();
        if (!kycList[from] || !kycList[_to]) revert NotInKycList(from, _to);
        if (_amount == 0) revert InvalidAmount();
        if (_asset == address(0)) revert InvalidAddress();
        if (_asset == underlying) revert UnderlyingNotAllowed();

        token.burn(from, _amount);

        emit OffchainRedeem(from, _to, _asset, _amount);
    }
```

- [ ] **Step 2: Compile**

Run: `npm run compile`
Expected: clean build. TypeChain types regenerate as part of compile.

- [ ] **Step 3: Run the happy-path test to verify it passes**

Run: `npx hardhat test test/unit/Express.directRedeem.test.ts`
Expected: PASS — 1 passing.

- [ ] **Step 4: Commit**

```bash
git add contracts/extension/Express.sol
git commit -m "feat(express): add requestDirectRedeem for off-chain settlement"
```

---

## Task 4: Add revert tests

**Files:**
- Modify: `test/unit/Express.directRedeem.test.ts`

- [ ] **Step 1: Add a `describe('reverts', ...)` block**

Insert a new `describe` block inside the outer `describe('Express - requestDirectRedeem', ...)` block, between the existing `happy path` describe and the closing `});`. Paste this verbatim:

```typescript
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
```

Note: the `paused` test uses `revertedWith` (string match) because Prism's `ExpressPausable` uses `require()` with a string, not a custom error. Verified during plan writing.

- [ ] **Step 2: Run the tests**

Run: `npx hardhat test test/unit/Express.directRedeem.test.ts`
Expected: PASS — 8 passing (1 happy path + 7 reverts).

- [ ] **Step 3: Commit**

```bash
git add test/unit/Express.directRedeem.test.ts
git commit -m "test(express): revert cases for requestDirectRedeem"
```

---

## Task 5: Add coexistence test

**Files:**
- Modify: `test/unit/Express.directRedeem.test.ts`

- [ ] **Step 1: Add a `describe('coexistence with queued flow', ...)` block**

Insert immediately before the outer closing `});`. Paste verbatim:

```typescript
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
```

- [ ] **Step 2: Run tests**

Run: `npx hardhat test test/unit/Express.directRedeem.test.ts`
Expected: PASS — 9 passing.

- [ ] **Step 3: Commit**

```bash
git add test/unit/Express.directRedeem.test.ts
git commit -m "test(express): coexistence test for requestDirectRedeem"
```

---

## Task 6: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Locate the redeem flow description**

Open `CLAUDE.md` and search for descriptions of the existing `redeemRequest` flow (likely under a section heading like "Core Contract Architecture", "Express Contract Flow", or similar). The exact location may vary — find the spot that describes the existing redeem path.

If there is no such section yet, add a new section near the bottom titled `## Off-Chain Direct Redeem`.

- [ ] **Step 2: Add the new path description**

Add this paragraph (either as a new bullet within the existing redeem-flow description, or as the body of the new section):

```markdown
**Off-chain direct redeem flow (`requestDirectRedeem`):** user picks an arbitrary settlement asset (e.g. RLUSD) by address, PRISM tokens are burned immediately on-chain via `token.burn`, and `OffchainRedeem` is emitted. No queue, no on-chain fee, no oracle — the back-office DB matches the event and pays out off-chain in the requested asset. Rejects `_asset == 0` and `_asset == underlying` (the latter forces the standard asset through `redeemRequest`'s queued path).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): document direct-redeem off-chain settlement path"
```

---

## Task 7: Run full unit suite + format

**Files:** none modified by the engineer; the formatter may modify some.

- [ ] **Step 1: Run all unit tests**

Run: `npm run test:unit`
Expected: all suites pass with no regressions. The new `Express.directRedeem.test.ts` contributes 9 passing tests.

If anything fails that ISN'T the new test file, STOP and report BLOCKED — do not attempt fixes; the production code change should be additive only.

- [ ] **Step 2: Run the formatter**

Run: `npm run format`

- [ ] **Step 3: Check what changed**

Run: `git status` and `git diff --stat`.

- [ ] **Step 4: If the formatter changed files, commit**

If `git status` shows modified files:

```bash
git add -A
git commit -m "chore: apply formatter after direct-redeem changes"
```

If nothing changed, skip the commit.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Covered by task |
|---|---|
| Function signature | Task 3 |
| Validation guards (KYC, amount > 0, zero asset, underlying check) | Task 3 (impl) + Task 4 (tests) |
| Body (`token.burn` + `emit`) | Task 3 |
| Event signature | Task 1 (decl) + Task 3 (emit) + Task 2 (test) |
| New error `UnderlyingNotAllowed` | Task 1 |
| Test plan items 1–3 (happy, reverts, coexistence) | Tasks 2, 4, 5 |
| `CLAUDE.md` update | Task 6 |
| No new state, roles, constants beyond one error | Task 1 (only adds error+event); Task 3 (only adds function) |

**2. Placeholder scan:** no TBDs; every step contains exact code or exact diff. Two notes about "verify error name" in the spec were resolved during pre-plan investigation and are baked into Task 3 and Task 4 with concrete error names.

**3. Type consistency:** function signature `requestDirectRedeem(address _asset, uint256 _amount, address _to)` and event `OffchainRedeem(from, to, asset, tokenAmount)` are identical across spec, Task 1, Task 2, Task 3, Task 4, Task 5. Error names (`InvalidAmount`, `InvalidAddress`, `NotInKycList`, `UnderlyingNotAllowed`) match across declaration and assertions.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-06-direct-redeem.md` (in the `prism-contract` repo, branch `wp/direct-redeem`). Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
