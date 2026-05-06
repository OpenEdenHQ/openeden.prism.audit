# Prism Direct Redeem (Off-Chain Settlement) — Design Spec

**Status:** Approved
**Date:** 2026-05-06
**Component:** `contracts/extension/Express.sol`

## Problem

Prism's existing redeem path (`redeemRequest` → `processRedemptionQueue`) settles every redemption in a single fixed `underlying` asset (e.g. USDO). Users who want to off-ramp into a different asset (e.g. RLUSD) cannot be served on-chain.

We need a redeem path that:

1. Lets the user nominate the asset they want to receive (informationally — the contract does not pay it).
2. Burns the user's PRISM tokens immediately, without queueing or T+N delay.
3. Records a burn event the off-chain settlement layer (DB + ops) can match against and pay out in the requested asset.

The contract must remain neutral about the settlement asset — it has no oracle for RLUSD or other arbitrary assets, and acquiring oracles per asset is out of scope.

This spec is a port of the analogous HYBOND feature (see `openeden.hybond.audit/docs/superpowers/specs/2026-05-06-direct-redeem-design.md`), simplified for Prism's lighter contract model.

## Non-Goals

- On-chain pricing, fee, or limit logic for the off-chain settlement asset.
- On-chain remediation if off-chain settlement fails (handled by ops/back-office).
- Any whitelist of supported settlement assets (the DB is the source of truth).
- Replacing the existing `redeemRequest` flow — the standard `underlying` asset continues to use the queued path.

## Solution Overview

A new external function `requestDirectRedeem` on `contracts/extension/Express.sol`:

- Validates KYC + pause state.
- Validates `_asset` is non-zero and not equal to `underlying`.
- Burns the user's PRISM tokens immediately via `token.burn(from, _amount)` (no escrow, no queue).
- Emits `OffchainRedeem` with the burn record.

The off-chain DB matches `OffchainRedeem` events to settlement payouts. The contract is fire-and-forget on the burn side. Express already holds `BURNER_ROLE` on the Token contract.

## Differences From HYBOND Port

The HYBOND analog uses a share-based ratio model (`offchainShares` / `_sharesPerToken`) and has a special `mgtFeeTo` role. Prism has neither. The Prism port therefore drops:

- `shareAmount` field from the event (Prism is implicitly 1:1).
- `offchainShares` decrement (no such state).
- `totalRedeemQueueTokens` (no such state).
- `mgtFeeTo` rejection guard (no such role).
- Ratio-invariance test (no ratio).

## Function Signature

```solidity
/**
 * @notice Redeem PRISM tokens with off-chain settlement in an arbitrary asset.
 * @dev Burns tokens immediately. The settlement payout is handled fully off-chain;
 *      the contract only emits the burn record for the DB to match against.
 *      No queue, no on-chain fee, no T+N delay; fees are applied off-chain at
 *      settlement time.
 * @param _asset Informational asset address the user wants to receive off-chain
 *               (e.g. RLUSD). Must be non-zero and not equal to underlying.
 * @param _amount PRISM token amount to burn.
 * @param _to KYC'd recipient address recorded for off-chain settlement.
 */
function requestDirectRedeem(
    address _asset,
    uint256 _amount,
    address _to
) external whenNotPausedRedeem;
```

Placement: in `contracts/extension/Express.sol`, immediately after the existing `redeemRequest` function (around line 412).

## Validation & Guards

In order:

1. `whenNotPausedRedeem` modifier (existing pattern).
2. `from = _msgSender()`.
3. `if (!kycList[from] || !kycList[_to]) revert NotInKycList(from, _to);` — same KYC pattern as `redeemRequest`.
4. `if (_amount == 0) revert InvalidAmount();`
5. `if (_asset == address(0)) revert InvalidAddress();` (verify error name during plan; if Prism uses a different name like `ZeroAddress`, use that.)
6. `if (_asset == underlying) revert UnderlyingNotAllowed();` — new named error.

No `_redeemMinimum` check (off-chain settlement may have different economics).

## Body

```solidity
(uint256 feeAmt, uint256 receiveAmt) = previewRedeem(_amount);
token.burn(from, _amount);
emit OffchainRedeem(from, _to, _asset, _amount, receiveAmt, feeAmt);
```

No state mutations. No escrow. No queue. The burn relies on Express's pre-existing `BURNER_ROLE` on the Token contract.

## Event

```solidity
event OffchainRedeem(
    address indexed from,
    address indexed to,
    address indexed asset,
    uint256 amount,
    uint256 receiveAmt,
    uint256 feeAmt
);
```

Indexed: `from`, `to`, `asset` (highest-cardinality lookup keys for DB queries). The DB matches settlement events on `(txhash, logIndex)` natively — no on-chain id needed.

## New Errors

```solidity
error UnderlyingNotAllowed();
```

`InvalidAmount`, `NotInKycList` already exist in Prism's Express. `InvalidAddress` may or may not — verify during plan and adjust the spec/code accordingly.

## Test Plan

Location: new `test/unit/Express.directRedeem.test.ts`.

1. **Happy path** — KYC'd user burns N tokens; `OffchainRedeem` emitted with correct args; `totalSupply` drops by N; `balanceOf(from)` drops by N.
2. **Reverts:**
   - `_amount == 0` → `InvalidAmount`
   - `_asset == address(0)` → zero-address error
   - `_asset == underlying` → `UnderlyingNotAllowed`
   - non-KYC `from` → `NotInKycList`
   - non-KYC `to` → `NotInKycList`
   - paused → Prism's pause-redeem error (verify name)
   - balance insufficient → ERC20 revert (`to.be.reverted`)
3. **Coexistence** — interleave with `instantMint` and `redeemRequest` + `processRedemptionQueue`; assert no drift in redemption queue length, treasury balances, or fee accumulation.

Total: 9 tests.

## Out-of-Scope / Unchanged

- No new state variables, roles, or constants (only one new error).
- No changes to `instantMint`, `redeemRequest`, `processRedemptionQueue`, `previewRedeem`, `_distributeToken`.
- No changes to `Token.sol`, `AssetRegistry.sol`, `ExpressPausable.sol`, `MintRedeemLimiter.sol`.
- No upgrade-storage concerns: purely additive logic.

## Operational Invariant (off-chain)

- **Off-chain settlement of `requestDirectRedeem` burns is the operator's responsibility.** Failure to settle = user lost tokens with no on-chain recourse. Operators must monitor `OffchainRedeem` events and reconcile against settlement payouts.

## Documentation Updates

- Update `CLAUDE.md` to mention the third redeem path (off-chain settlement) alongside the existing `instantMint` / `redeemRequest` flows.

## Decisions Log

| # | Decision | Chosen | Reasoning |
|---|----------|--------|-----------|
| 1 | Port shape | Faithful HYBOND port, simplified | Cross-contract DB matcher reuse; same mental model |
| 2 | Limits | KYC + amount > 0 + pause only | `_redeemMinimum` is sized for `underlying`; off-chain may differ |
| 3 | Asset guards | `_asset != 0` AND `_asset != underlying` | Cheap foot-gun prevention without whitelist |
| 4 | Fee/burn | No on-chain fee, direct `token.burn(from, amount)` | No state to maintain; saves transfer gas; Express has BURNER_ROLE |
| 5 | Naming | `requestDirectRedeem` / `OffchainRedeem` | Matches HYBOND for cross-contract symmetry |
| 6 | Event payload | 6 fields: (from, to, asset, amount, receiveAmt, feeAmt) | Prism has no shares; gross+net+fee triple lets DB reconcile without recomputing |
| 7 | Fee field shape | Emit both `receiveAmt` and `feeAmt` from previewRedeem | Explicit gross/net/fee split lets DB reconcile without recomputing; no on-chain fee transfer |
