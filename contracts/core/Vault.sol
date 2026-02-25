// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlEnumerableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IToken is IERC20Metadata {
    function isBanned(address) external view returns (bool);
    function paused() external view returns (bool);
}

interface IRedemptionQueue {
    function enqueue(
        address user,
        uint256 assets,
        uint256 shares
    ) external returns (uint256 redemptionId);
}

contract Vault is
    Initializable,
    ERC20Upgradeable,
    ERC20PausableUpgradeable,
    ERC4626Upgradeable,
    AccessControlEnumerableUpgradeable,
    UUPSUpgradeable
{
    error InvalidAddress();
    error InvalidAmount();
    error BannedAddress(address user);
    error UseStakeInstead();
    error UseUnstakeInstead();
    error VaultPausedTransfers();
    error FlashLoanDetected();
    error InsufficientOutput(uint256 received, uint256 minimum);

    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 public constant UPGRADE_ROLE = keccak256("UPGRADE_ROLE");
    address public redemptionQueue;

    // Flash loan protection: track last action block per user
    mapping(address => uint256) private lastActionBlock;

    event Staked(address indexed user, uint256 amount, uint256 shares);
    event UnstakeRequested(
        address indexed user,
        uint256 indexed redemptionId,
        uint256 assets,
        uint256 shares,
        uint256 requestTime
    );
    event RedemptionQueueSet(address indexed redemptionQueue);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the vault
     * @param _asset token address
     * @param _name Token Vault
     * @param _symbol xToken
     * @param _admin Default admin address
     * @param _redemptionQueue RedemptionQueue address
     */
    function initialize(
        IToken _asset,
        string memory _name,
        string memory _symbol,
        address _admin,
        address _redemptionQueue
    ) external initializer {
        __ERC20_init(_name, _symbol);
        __ERC20Pausable_init();
        __ERC4626_init(_asset);
        __AccessControlEnumerable_init();
        __UUPSUpgradeable_init();

        if (_admin == address(0)) revert InvalidAddress();
        if (_redemptionQueue == address(0)) revert InvalidAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        redemptionQueue = _redemptionQueue;
    }

    /**
     * @notice Override decimals to match asset
     * @dev Vault token decimals will match the underlying asset (18 decimals)
     * @dev Initial deposit protection: Make an initial deposit of at least 100 token immediately after deployment
     */
    function decimals()
        public
        view
        override(ERC20Upgradeable, ERC4626Upgradeable)
        returns (uint8)
    {
        return ERC4626Upgradeable.decimals();
    }

    function stake(
        uint256 _amount,
        uint256 _minSharesOut
    ) external returns (uint256) {
        if (_amount == 0) revert InvalidAmount();
        uint256 shares = _stake(msg.sender, _amount);
        if (shares < _minSharesOut)
            revert InsufficientOutput(shares, _minSharesOut);
        return shares;
    }

    function stakeFor(
        address _user,
        uint256 _amount,
        uint256 _minSharesOut
    ) external returns (uint256) {
        if (_amount == 0) revert InvalidAmount();
        uint256 shares = _stake(_user, _amount);
        if (shares < _minSharesOut)
            revert InsufficientOutput(shares, _minSharesOut);
        return shares;
    }

    function unstake(uint256 _shares) external returns (uint256) {
        if (_shares == 0) revert InvalidAmount();
        return _unstake(msg.sender, _shares);
    }

    /****************************************************
     * DISABLED FUNCTIONS
     ****************************************************/

    function deposit(
        uint256 assets,
        address receiver
    ) public override returns (uint256) {
        revert UseStakeInstead();
    }

    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) public override returns (uint256) {
        revert UseUnstakeInstead();
    }

    function mint(
        uint256 shares,
        address receiver
    ) public override returns (uint256) {
        revert UseStakeInstead();
    }

    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override returns (uint256) {
        revert UseUnstakeInstead();
    }

    function paused() public view override returns (bool) {
        return IToken(asset()).paused() || super.paused();
    }

    function pause() external onlyRole(PAUSE_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSE_ROLE) {
        _unpause();
    }

    function setRedemptionQueue(
        address _redemptionQueue
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_redemptionQueue == address(0)) revert InvalidAddress();

        redemptionQueue = _redemptionQueue;
        emit RedemptionQueueSet(_redemptionQueue);
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        if (from != address(0)) {
            if (IToken(asset()).isBanned(from)) revert BannedAddress(from);
        }
        if (to != address(0)) {
            if (IToken(asset()).isBanned(to)) revert BannedAddress(to);
        }

        if (paused()) revert VaultPausedTransfers();
        super._update(from, to, value);
    }

    function _stake(address _user, uint256 _amount) internal returns (uint256) {
        address sender = msg.sender;

        // Check flash loan protection for both sender and recipient
        if (lastActionBlock[sender] == block.number) revert FlashLoanDetected();
        if (lastActionBlock[_user] == block.number) revert FlashLoanDetected();

        // Update last action block for both sender and recipient
        lastActionBlock[sender] = block.number;
        lastActionBlock[_user] = block.number;

        uint256 shares = super.deposit(_amount, _user);
        emit Staked(_user, _amount, shares);
        return shares;
    }

    function _unstake(
        address _user,
        uint256 _shares
    ) internal returns (uint256) {
        if (lastActionBlock[_user] == block.number) revert FlashLoanDetected();
        lastActionBlock[_user] = block.number;

        uint256 assets = super.redeem(_shares, redemptionQueue, _user);

        uint256 redemptionId = IRedemptionQueue(redemptionQueue).enqueue(
            _user,
            assets,
            _shares
        );
        emit UnstakeRequested(
            _user,
            redemptionId,
            assets,
            _shares,
            block.timestamp
        );

        return assets;
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal view override onlyRole(UPGRADE_ROLE) {
        if (newImplementation == address(0)) revert InvalidAddress();
    }

    uint256[45] private __gap;
}
