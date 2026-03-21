// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

struct MintRedeemLimiterCfg {
    uint256 mintMinimum;
    uint256 redeemMinimum;
    uint256 firstDepositAmount;
}

/**
 * @title MintRedeemLimiter
 * @notice contract implementing minimum thresholds for minting and redeeming.
 */
abstract contract MintRedeemLimiter is Initializable {
    uint256 public _mintMinimum;
    uint256 public _redeemMinimum;
    uint256 public _firstDepositAmount;

    event MintMinimumUpdated(uint256 newMinimum);
    event RedeemMinimumUpdated(uint256 newMinimum);
    event FirstDepositAmount(uint256 amount);
    error RedeemLessThanMinimum(uint256 amount, uint256 minimum);

    /**
     * @notice Initializes mint and redeem minimums.
     * @param mintMinimum    Min amount allowed to mint in one transaction (in token decimals - 18)
     * @param redeemMinimum  Min amount allowed to redeem in one transaction (in token decimals - 18)
     * @param firstDepositAmount The first deposit amount (in token decimals - 18)
     */

    function __MintRedeemLimiter_init(
        uint256 mintMinimum,
        uint256 redeemMinimum,
        uint256 firstDepositAmount
    ) internal onlyInitializing {
        _mintMinimum = mintMinimum;
        _redeemMinimum = redeemMinimum;
        _firstDepositAmount = firstDepositAmount;
    }

    /*//////////////////////////////////////////////////////////////
                          Mint Functions
    //////////////////////////////////////////////////////////////*/
    /**
     * @dev Updates the mint minimum.
     * @dev Amount should be in token decimals (18) for accurate comparison across different underlying assets
     * @param mintMinimum New mint minimum in token equivalent.
     */
    function _setMintMinimum(uint256 mintMinimum) internal {
        _mintMinimum = mintMinimum;
        emit MintMinimumUpdated(mintMinimum);
    }

    /**
     * @dev Updates the redeem minimum.
     * @param redeemMinimum New redeem minimum.
     */
    function _setRedeemMinimum(uint256 redeemMinimum) internal {
        _redeemMinimum = redeemMinimum;
        emit RedeemMinimumUpdated(redeemMinimum);
    }

    /**
     * @notice Set the first deposit amount
     * @dev Amount should be in token decimals (18) for accurate comparison across different underlying assets
     * @param amount The first deposit amount in token equivalent
     */
    function _setFirstDepositAmount(uint256 amount) internal {
        _firstDepositAmount = amount;
        emit FirstDepositAmount(amount);
    }

    uint256[10] private __gap;
}
