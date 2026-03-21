// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title RedemptionQueue
 * @notice Manages T+N unstaking queue for Vault
 * @dev Users queue redemptions, wait N days, then claim token
 */
contract RedemptionQueue is
    Initializable,
    AccessControlEnumerableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant UPGRADE_ROLE = keccak256("UPGRADE_ROLE");

    struct Redemption {
        address user;
        uint256 assets; // token amount to receive
        uint256 shares; // Vault shares burned
        uint256 queuedAt; // Timestamp when queued
        uint256 claimableAt; // Timestamp when claimable
        bool processed; // True if claimed
    }

    IERC20 public asset;
    uint256 public delay;
    address public vault;

    mapping(address => mapping(uint256 => Redemption)) public redemptions;
    mapping(address => uint256) public redemptionCount;

    event RedemptionQueued(
        address indexed user,
        uint256 indexed redemptionId,
        uint256 assets,
        uint256 shares,
        uint256 claimableAt
    );
    event RedemptionClaimed(
        address indexed user,
        uint256 indexed redemptionId,
        uint256 assets
    );
    event delayUpdated(uint256 oldDelay, uint256 newDelay);
    event VaultUpdated(address oldVault, address newVault);
    event EmergencyWithdraw(
        address indexed token,
        address indexed to,
        uint256 amount,
        address indexed admin
    );

    error InvalidAddress();
    error InvalidAmount();
    error OnlyVault();
    error NotYourRedemption();
    error AlreadyProcessed();
    error StillInQueue();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the contract
     * @param _admin Default admin address
     * @param _asset token address
     * @param _vault Vault address
     * @param _delay Processing delay in seconds (e.g., 7 days = 604800)
     */
    function initialize(
        address _admin,
        address _asset,
        address _vault,
        uint256 _delay
    ) public initializer {
        __AccessControlEnumerable_init();
        __UUPSUpgradeable_init();

        if (_admin == address(0)) revert InvalidAddress();
        if (_asset == address(0)) revert InvalidAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        asset = IERC20(_asset);
        vault = _vault;
        delay = _delay;
    }

    /**
     * @notice Enqueue redemption (called by vault)
     * @param user User address
     * @param assets token amount to receive
     * @param shares Vault shares burned
     * @return redemptionId ID of the redemption
     */
    function enqueue(
        address user,
        uint256 assets,
        uint256 shares
    ) external returns (uint256 redemptionId) {
        if (msg.sender != vault) revert OnlyVault();
        if (user == address(0)) revert InvalidAddress();

        redemptionId = redemptionCount[user];
        redemptionCount[user]++;

        uint256 claimableAt = block.timestamp + delay;

        redemptions[user][redemptionId] = Redemption({
            user: user,
            assets: assets,
            shares: shares,
            queuedAt: block.timestamp,
            claimableAt: claimableAt,
            processed: false
        });

        emit RedemptionQueued(user, redemptionId, assets, shares, claimableAt);
    }

    /**
     * @notice Claim redeemed assets
     * @param redemptionId ID of the redemption
     */
    function claim(uint256 redemptionId) external {
        address user = msg.sender;
        Redemption storage redemption = redemptions[user][redemptionId];

        if (redemption.user != user) revert NotYourRedemption();
        if (redemption.processed) revert AlreadyProcessed();
        if (block.timestamp < redemption.claimableAt) revert StillInQueue();

        redemption.processed = true;
        asset.safeTransfer(user, redemption.assets);

        emit RedemptionClaimed(user, redemptionId, redemption.assets);
    }

    /**
     * @notice Get all pending redemptions for user (convenience function)
     * @param user User address
     * @return Array of all pending redemptions
     * @dev For large lists, consider calling getRedemption() individually
     */
    function getAllPendingRedemptions(
        address user
    ) external view returns (Redemption[] memory) {
        uint256 count = redemptionCount[user];
        uint256 pendingCount;

        // Count pending redemptions
        for (uint256 i; i < count; ) {
            if (!redemptions[user][i].processed) {
                unchecked {
                    ++pendingCount;
                }
            }
            unchecked {
                ++i;
            }
        }

        // Populate array
        Redemption[] memory pending = new Redemption[](pendingCount);
        uint256 index;
        for (uint256 i; i < count; ) {
            if (!redemptions[user][i].processed) {
                pending[index] = redemptions[user][i];
                unchecked {
                    ++index;
                }
            }
            unchecked {
                ++i;
            }
        }

        return pending;
    }

    /**
     * @notice Get specific redemption
     * @param user User address
     * @param redemptionId Redemption ID
     * @return Redemption details
     */
    function getRedemption(
        address user,
        uint256 redemptionId
    ) external view returns (Redemption memory) {
        return redemptions[user][redemptionId];
    }

    /**
     * @notice Set processing delay
     * @param newDelay New delay in seconds
     */
    function setdelay(uint256 newDelay) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldDelay = delay;
        delay = newDelay;

        emit delayUpdated(oldDelay, newDelay);
    }

    /**
     * @notice Set vault address
     * @param newVault New vault address
     */
    function setVault(address newVault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newVault == address(0)) revert InvalidAddress();

        address oldVault = vault;
        vault = newVault;

        emit VaultUpdated(oldVault, newVault);
    }

    /**
     * @notice Emergency withdraw (admin only)
     * @param token Token address
     * @param to Recipient
     * @param amount Amount
     */
    function emergencyWithdraw(
        address token,
        address to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert InvalidAddress();
        IERC20(token).safeTransfer(to, amount);
        emit EmergencyWithdraw(token, to, amount, msg.sender);
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal view override onlyRole(UPGRADE_ROLE) {
        if (newImplementation == address(0)) revert InvalidAddress();
    }

    function version() external pure returns (string memory) {
        return "1.0.0";
    }

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[45] private __gap;
}
