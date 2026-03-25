// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import "./ExpressPausable.sol";
import "./MintRedeemLimiter.sol";
import "./DoubleQueueModified.sol";
import {IToken} from "../interfaces/IToken.sol";
import "../interfaces/IAssetRegistry.sol";

/**
 * @title Express
 * @notice Token Express - Mint and Redemption Gateway
 * @dev Upgradeable contract for instant minting and queued token redemption with compliance controls
 *
 * Key Features:
 * - Instant mint with underlying assets (USDO, etc.)
 * - Queued redemption system for liquidity management
 * - KYC/compliance enforcement
 * - Fee management for mints and redemptions
 * - First deposit requirements
 * - Rate limiting for mints and redeems
 * - Integration with asset registry
 * - Upgradeable via UUPS pattern
 */

enum TxType {
    MINT,
    REDEEM
}

contract Express is
    Initializable,
    UUPSUpgradeable,
    AccessControlEnumerableUpgradeable,
    ExpressPausable,
    MintRedeemLimiter
{
    using Math for uint256;
    using DoubleQueueModified for DoubleQueueModified.BytesDeque;
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 ROLES
    //////////////////////////////////////////////////////////////*/

    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 public constant WHITELIST_ROLE = keccak256("WHITELIST_ROLE");
    bytes32 public constant MAINTAINER_ROLE = keccak256("MAINTAINER_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant UPGRADE_ROLE = keccak256("UPGRADE_ROLE");

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 private constant BPS_BASE = 1e4;
    uint256 private constant PRICE_BASE = 1e8;

    /*//////////////////////////////////////////////////////////////
                            STATE VARIABLES
    //////////////////////////////////////////////////////////////*/

    // Fee configuration (in basis points, 1e4)
    uint256 public mintFeeRate;
    uint256 public redeemFeeRate;

    // Core token addresses
    IToken public token;
    address public underlying;
    address public treasury;
    address public feeTo;

    // External contract integrations
    IAssetRegistry public assetRegistry;
    address public redemptionContract;

    // User state tracking
    mapping(address => bool) public firstDeposit;
    mapping(address => bool) public kycList;
    mapping(address => uint256) private redemptionInfo;

    // Redemption queue
    DoubleQueueModified.BytesDeque private redemptionQueue;

    // Escrow for cancelled redemptions that couldn't be refunded (e.g. banned sender)
    mapping(address => uint256) public escrowBalance;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event UpdateMintFeeRate(uint256 fee);
    event UpdateRedeemFeeRate(uint256 fee);
    event UpdateTreasury(address indexed treasury);
    event UpdateFeeTo(address indexed feeTo);
    event AssetRegistryUpdated(address indexed newRegistry);
    event SetRedemption(address indexed redemptionContract);

    event InstantMint(
        address indexed underlying,
        address indexed from,
        address indexed to,
        uint256 requiredAmt,
        uint256 receivedAmt,
        uint256 fee
    );

    event AddToRedemptionQueue(
        address indexed from,
        address indexed to,
        uint256 amount,
        bytes32 indexed id
    );

    event ProcessRedeem(
        address indexed from,
        address indexed to,
        uint256 requiredAmt,
        uint256 receivedAmt,
        uint256 feeAmt,
        bytes32 indexed id
    );

    event ProcessRedemptionCancel(
        address indexed from,
        address indexed to,
        uint256 requiredAmt,
        bytes32 indexed id
    );

    event OffRamp(address indexed to, uint256 amount);
    event UpdateFirstDeposit(address indexed account, bool flag);
    event KycGranted(address[] addresses);
    event KycRevoked(address[] addresses);
    event EscrowDeposit(address indexed account, uint256 amount);
    event EscrowClaimed(address indexed account, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error InvalidAddress();
    error InvalidAmount();
    error InvalidInput(uint256 input);
    error UpdateTooEarly(uint256 timestamp);
    error NotInKycList(address from, address to);
    error InsufficientLiquidity(uint256 required, uint256 available);
    error InsufficientOutput(uint256 received, uint256 minimum);
    error MintLessThanMinimum(uint256 amount, uint256 minimum);
    error FirstDepositLessThanRequired(uint256 amount, uint256 minimum);
    error EmptyQueue();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /*//////////////////////////////////////////////////////////////
                             INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Initialize the Express contract
     * @param _token Address of the token contract
     * @param _underlying Address of the underlying token
     * @param _treasury Address to receive underlying assets
     * @param _feeTo Address to receive fees
     * @param admin Address with admin privileges
     * @param _assetRegistry Address of the asset registry
     * @param cfg Mint and redeem limiter configuration
     */
    function initialize(
        address _token,
        address _underlying,
        address _treasury,
        address _feeTo,
        address admin,
        address _assetRegistry,
        MintRedeemLimiterCfg memory cfg
    ) external initializer {
        if (admin == address(0)) revert InvalidAddress();

        __AccessControlEnumerable_init();
        __UUPSUpgradeable_init();

        token = IToken(_token);
        underlying = _underlying;
        treasury = _treasury;
        feeTo = _feeTo;
        assetRegistry = IAssetRegistry(_assetRegistry);

        __MintRedeemLimiter_init(
            cfg.mintMinimum,
            cfg.redeemMinimum,
            cfg.firstDepositAmount
        );

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /*//////////////////////////////////////////////////////////////
                         CONTRACT MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Update the asset registry address
     * @param _address The new asset registry address
     */
    function setAssetRegistry(
        address _address
    ) external onlyRole(MAINTAINER_ROLE) {
        if (_address == address(0)) revert InvalidAddress();
        assetRegistry = IAssetRegistry(_address);
        emit AssetRegistryUpdated(_address);
    }

    /**
     * @notice Set the redemption contract address
     * @param _address Address of the redemption contract
     */
    function setRedemption(
        address _address
    ) external onlyRole(MAINTAINER_ROLE) {
        if (_address == address(0)) revert InvalidAddress();
        redemptionContract = _address;
        emit SetRedemption(_address);
    }

    /**
     * @notice Update the treasury address
     * @param _address The new treasury address
     */
    function updateTreasury(
        address _address
    ) external onlyRole(MAINTAINER_ROLE) {
        if (_address == address(0)) revert InvalidAddress();
        treasury = _address;
        emit UpdateTreasury(_address);
    }

    /**
     * @notice Update the fee recipient address
     * @param _address The new fee recipient address
     */
    function updateFeeTo(address _address) external onlyRole(MAINTAINER_ROLE) {
        if (_address == address(0)) revert InvalidAddress();
        feeTo = _address;
        emit UpdateFeeTo(_address);
    }

    /*//////////////////////////////////////////////////////////////
                           FEE MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Update the mint fee rate
     * @param _rate The new fee rate in basis points
     */
    function updateMintFee(uint256 _rate) external onlyRole(MAINTAINER_ROLE) {
        if (_rate > BPS_BASE) revert InvalidInput(_rate);
        mintFeeRate = _rate;
        emit UpdateMintFeeRate(_rate);
    }

    /**
     * @notice Update the redeem fee rate
     * @param _rate The new fee rate in basis points
     */
    function updateRedeemFee(uint256 _rate) external onlyRole(MAINTAINER_ROLE) {
        if (_rate > BPS_BASE) revert InvalidInput(_rate);
        redeemFeeRate = _rate;
        emit UpdateRedeemFeeRate(_rate);
    }

    /**
     * @notice Calculate transaction fee based on amount and type
     * @param _amount The amount to calculate fee for
     * @param _txType The transaction type (MINT or REDEEM)
     * @return feeAmt The calculated fee amount
     */
    function txsFee(
        uint256 _amount,
        TxType _txType
    ) public view returns (uint256 feeAmt) {
        uint256 feeRate;

        if (_txType == TxType.MINT) {
            feeRate = mintFeeRate;
        } else if (_txType == TxType.REDEEM) {
            feeRate = redeemFeeRate;
        }

        feeAmt = (_amount * feeRate) / BPS_BASE;
    }

    /*//////////////////////////////////////////////////////////////
                          INSTANT MINTING
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Perform instant mint of token from underlying asset
     * @param _asset The address of the underlying token
     * @param _to The address to receive the minted token
     * @param _amount The amount of underlying token to deposit
     * @param _minMintOut Minimum amount of tokens to receive (slippage protection)
     */
    function instantMint(
        address _asset,
        address _to,
        uint256 _amount,
        uint256 _minMintOut
    ) external whenNotPausedMint {
        address from = _msgSender();
        if (!kycList[from] || !kycList[_to]) revert NotInKycList(from, _to);
        if (_amount == 0) revert InvalidAmount();

        uint256 equivalentAmount = convertFromUnderlying(_asset, _amount);

        if (!firstDeposit[from]) {
            if (equivalentAmount < _firstDepositAmount) {
                revert FirstDepositLessThanRequired(
                    equivalentAmount,
                    _firstDepositAmount
                );
            }
            firstDeposit[from] = true;
        } else {
            if (equivalentAmount < _mintMinimum) {
                revert MintLessThanMinimum(equivalentAmount, _mintMinimum);
            }
        }

        uint256 netAmt;
        uint256 feeAmt;
        uint256 mintAmt;
        (netAmt, feeAmt, mintAmt) = previewMint(_asset, _amount);

        if (mintAmt < _minMintOut)
            revert InsufficientOutput(mintAmt, _minMintOut);

        if (feeAmt > 0) {
            IERC20(_asset).safeTransferFrom(from, feeTo, feeAmt);
        }
        IERC20(_asset).safeTransferFrom(from, treasury, netAmt);

        token.mint(_to, mintAmt);
        emit InstantMint(_asset, from, _to, _amount, mintAmt, feeAmt);
    }

    /**
     * @notice Preview mint amounts
     * @param _underlying The underlying token address
     * @param _amount The amount of underlying token
     * @return netAmt Net amount after fees
     * @return feeAmt Fee amount
     * @return mintAmt token amount to be minted
     */
    function previewMint(
        address _underlying,
        uint256 _amount
    ) public view returns (uint256 netAmt, uint256 feeAmt, uint256 mintAmt) {
        feeAmt = txsFee(_amount, TxType.MINT);
        netAmt = _amount - feeAmt;
        mintAmt = convertFromUnderlying(_underlying, netAmt);
    }

    /*//////////////////////////////////////////////////////////////
                            REDEMPTION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Queue a redemption request for manual processing
     * @param _to The address to receive redeemed token
     * @param _amount The amount of  to redeem
     */
    function redeemRequest(
        address _to,
        uint256 _amount
    ) external whenNotPausedRedeem {
        address from = _msgSender();
        if (!kycList[from] || !kycList[_to]) revert NotInKycList(from, _to);
        if (_amount == 0) revert InvalidAmount();
        if (_amount < _redeemMinimum)
            revert RedeemLessThanMinimum(_amount, _redeemMinimum);

        IERC20(address(token)).safeTransferFrom(from, address(this), _amount);
        redemptionInfo[_to] += _amount;

        bytes32 id = keccak256(
            abi.encode(
                from,
                _to,
                _amount,
                block.timestamp,
                redemptionQueue.length()
            )
        );
        bytes memory data = abi.encode(from, _to, _amount, id);
        redemptionQueue.pushBack(data);

        emit AddToRedemptionQueue(from, _to, _amount, id);
    }

    /**
     * @notice Preview redemption amounts
     * @param _amount The amount of token to redeem
     * @return feeAmt Platform fee amount in redeem token
     * @return redeemAmt redeem token amount user receives
     */
    function previewRedeem(
        uint256 _amount
    ) public view returns (uint256 feeAmt, uint256 redeemAmt) {
        return _previewRedeem(_amount, PRICE_BASE);
    }

    function _previewRedeem(
        uint256 _amount,
        uint256 _price
    ) internal view returns (uint256 feeAmt, uint256 redeemAmt) {
        uint256 underlyingAmt = convertToUnderlying(underlying, _amount).mulDiv(
            _price,
            PRICE_BASE
        );
        feeAmt = txsFee(underlyingAmt, TxType.REDEEM);
        redeemAmt = underlyingAmt - feeAmt;
    }

    /*//////////////////////////////////////////////////////////////
                       REDEMPTION QUEUE MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Process redemption queue at 1:1 price
     * @param _len Number of redemptions to process (0 = process all)
     */
    function processRedemptionQueue(
        uint256 _len
    ) external onlyRole(OPERATOR_ROLE) {
        _processRedemptionQueueInternal(_len, PRICE_BASE);
    }

    /**
     * @notice Process redemption queue with a custom price
     * @param _len Number of redemptions to process (0 = process all)
     * @param _price Price multiplier in 8 decimals (1e8 = 1.0)
     */
    function processRedemptionQueueWithPrice(
        uint256 _len,
        uint256 _price
    ) external onlyRole(MAINTAINER_ROLE) {
        if (_price >= PRICE_BASE || _price == 0) revert InvalidAmount();
        _processRedemptionQueueInternal(_len, _price);
    }

    /**
     * @notice Internal function to process redemption queue with price scaling
     * @param _len Number of redemptions to process (0 = process all)
     * @param _price Price multiplier in 8 decimals (1e8 = 1.0)
     */
    function _processRedemptionQueueInternal(
        uint256 _len,
        uint256 _price
    ) private {
        uint256 length = redemptionQueue.length();
        if (length == 0) revert EmptyQueue();
        if (_len > length) revert InvalidInput(_len);
        if (_len == 0) _len = length;

        for (uint256 count = 0; count < _len; ) {
            bytes memory data = redemptionQueue.front();
            (
                address sender,
                address receiver,
                uint256 amount,
                bytes32 prevId
            ) = _decodeData(data);

            if (!kycList[sender] || !kycList[receiver])
                revert NotInKycList(sender, receiver);

            (uint256 feeAmt, uint256 receiveAmt) = _previewRedeem(
                amount,
                _price
            );

            uint256 availableLiquidity = getTokenBalance(address(underlying));

            if ((receiveAmt + feeAmt) > availableLiquidity) {
                break;
            }

            redemptionQueue.popFront();

            unchecked {
                ++count;
                redemptionInfo[receiver] -= amount;
            }

            token.burn(address(this), amount);

            _distributeToken(underlying, receiver, receiveAmt, feeAmt);
            emit ProcessRedeem(
                sender,
                receiver,
                amount,
                receiveAmt,
                feeAmt,
                prevId
            );
        }
    }

    /**
     * @notice Cancel redemption requests and refund token
     * @param _len Number of requests to cancel
     */
    function cancel(uint256 _len) external onlyRole(MAINTAINER_ROLE) {
        if (redemptionQueue.empty()) revert EmptyQueue();
        if (_len > redemptionQueue.length()) revert InvalidInput(_len);
        if (_len == 0) revert InvalidAmount();

        while (_len > 0) {
            bytes memory data = redemptionQueue.popFront();
            (
                address sender,
                address receiver,
                uint256 amount,
                bytes32 prevId
            ) = _decodeData(data);

            unchecked {
                redemptionInfo[receiver] -= amount;
                --_len;
            }

            if (token.isBanned(sender)) {
                    escrowBalance[sender] += amount;
                    emit EscrowDeposit(sender, amount);
            } else {
                IERC20(address(token)).safeTransfer(sender, amount);
            }

            emit ProcessRedemptionCancel(sender, receiver, amount, prevId);
        }
    }

    /**
     * @notice Claim escrowed tokens from cancelled redemptions that could not be refunded directly
     * @dev Tokens are escrowed when cancel() cannot transfer back to the sender (e.g. sender was banned)
     */
    function claimEscrow() external {
        uint256 amount = escrowBalance[msg.sender];
        if (amount == 0) revert InvalidAmount();

        escrowBalance[msg.sender] = 0;
        IERC20(address(token)).safeTransfer(msg.sender, amount);
        emit EscrowClaimed(msg.sender, amount);
    }

    /**
     * @notice Get redemption queue information at index
     * @param _index Queue index to query
     * @return sender Sender address
     * @return receiver Receiver address
     * @return amount token amount
     * @return id Redemption ID
     */
    function getRedemptionQueueInfo(
        uint256 _index
    )
        external
        view
        returns (address sender, address receiver, uint256 amount, bytes32 id)
    {
        if (redemptionQueue.empty() || _index > redemptionQueue.length() - 1) {
            return (address(0), address(0), 0, 0x0);
        }

        bytes memory data = bytes(redemptionQueue.at(_index));
        (sender, receiver, amount, id) = _decodeData(data);
    }

    /**
     * @notice Get user's total queued redemption amount
     * @param _account User address
     * @return amount Total token amount in queue
     */
    function getRedemptionUserInfo(
        address _account
    ) external view returns (uint256 amount) {
        return redemptionInfo[_account];
    }

    /**
     * @notice Get redemption queue length
     * @return Length of the redemption queue
     */
    function getRedemptionQueueLength() external view returns (uint256) {
        return redemptionQueue.length();
    }

    /*//////////////////////////////////////////////////////////////
                           KYC MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Grant KYC status to multiple addresses
     * @param _addresses Array of addresses to grant KYC
     */
    function grantKycInBulk(
        address[] calldata _addresses
    ) external onlyRole(WHITELIST_ROLE) {
        uint256 length = _addresses.length;

        for (uint256 i; i < length; ) {
            kycList[_addresses[i]] = true;
            unchecked {
                ++i;
            }
        }

        emit KycGranted(_addresses);
    }

    /**
     * @notice Revoke KYC status from multiple addresses
     * @param _addresses Array of addresses to revoke KYC
     */
    function revokeKycInBulk(
        address[] calldata _addresses
    ) external onlyRole(WHITELIST_ROLE) {
        uint256 length = _addresses.length;

        for (uint256 i; i < length; ) {
            kycList[_addresses[i]] = false;
            unchecked {
                ++i;
            }
        }

        emit KycRevoked(_addresses);
    }

    /*//////////////////////////////////////////////////////////////
                         PAUSABLE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Pause minting operations
     */
    function pauseMint() external onlyRole(PAUSE_ROLE) {
        _pauseMint();
    }

    /**
     * @notice Unpause minting operations
     */
    function unpauseMint() external onlyRole(PAUSE_ROLE) {
        _unpauseMint();
    }

    /**
     * @notice Pause redemption operations
     */
    function pauseRedeem() external onlyRole(PAUSE_ROLE) {
        _pauseRedeem();
    }

    /**
     * @notice Unpause redemption operations
     */
    function unpauseRedeem() external onlyRole(PAUSE_ROLE) {
        _unpauseRedeem();
    }

    /*//////////////////////////////////////////////////////////////
                    MINT/REDEEM LIMITER FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Set mint minimum amount (in token, 18 decimals)
     * @param _mintMinimum Minimum mint amount
     */
    function setMintMinimum(
        uint256 _mintMinimum
    ) external onlyRole(MAINTAINER_ROLE) {
        _setMintMinimum(_mintMinimum);
    }

    /**
     * @notice Set redeem minimum amount (in token, 18 decimals)
     * @param _redeemMinimum Minimum redeem amount
     */
    function setRedeemMinimum(
        uint256 _redeemMinimum
    ) external onlyRole(MAINTAINER_ROLE) {
        _setRedeemMinimum(_redeemMinimum);
    }

    /**
     * @notice Set first deposit requirement amount (in token, 18 decimals)
     * @param _amount Required first deposit amount
     */
    function setFirstDepositAmount(
        uint256 _amount
    ) external onlyRole(MAINTAINER_ROLE) {
        _setFirstDepositAmount(_amount);
    }

    /**
     * @notice Update first deposit status for an account
     * @param _account Account address
     * @param _flag First deposit status
     */
    function updateFirstDeposit(
        address _account,
        bool _flag
    ) external onlyRole(MAINTAINER_ROLE) {
        if (_account == address(0)) revert InvalidAddress();
        firstDeposit[_account] = _flag;
        emit UpdateFirstDeposit(_account, _flag);
    }

    /*//////////////////////////////////////////////////////////////
                         TREASURY MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Transfer underlying from contract to treasury
     * @param _amount Amount of underlying to transfer
     */
    function offRamp(uint256 _amount) external onlyRole(OPERATOR_ROLE) {
        if (_amount == 0) revert InvalidAmount();
        IERC20(underlying).safeTransfer(treasury, _amount);
        emit OffRamp(treasury, _amount);
    }

    /**
     * @notice Get token balance held by this contract
     * @param _token Token address
     * @return Balance amount
     */
    function getTokenBalance(address _token) public view returns (uint256) {
        return IERC20(_token).balanceOf(address(this));
    }

    /*//////////////////////////////////////////////////////////////
                        CONVERSION HELPERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Convert underlying token amount to token amount
     * @param _token Underlying token address
     * @param _amount Amount of underlying token
     * @return amount Equivalent token amount
     */
    function convertFromUnderlying(
        address _token,
        uint256 _amount
    ) public view returns (uint256 amount) {
        return assetRegistry.convertFromUnderlying(_token, _amount);
    }

    /**
     * @notice Convert token amount to underlying token amount
     * @param _token Underlying token address
     * @param _amount Amount of token
     * @return amount Equivalent underlying token amount
     */
    function convertToUnderlying(
        address _token,
        uint256 _amount
    ) public view returns (uint256 amount) {
        return assetRegistry.convertToUnderlying(_token, _amount);
    }

    /*//////////////////////////////////////////////////////////////
                        INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Distribute token to recipient and fee collector
     * @param _token Token address
     * @param _to Recipient address
     * @param _amount Amount to send to user
     * @param _feeAmount Fee amount to send to feeTo
     */
    function _distributeToken(
        address _token,
        address _to,
        uint256 _amount,
        uint256 _feeAmount
    ) private {
        if (_feeAmount > 0) {
            IERC20(_token).safeTransfer(feeTo, _feeAmount);
        }
        IERC20(_token).safeTransfer(_to, _amount);
    }

    /**
     * @notice Decode redemption queue data
     * @param _data Encoded redemption data
     * @return sender Sender address
     * @return receiver Receiver address
     * @return amount token amount
     * @return prevId Redemption ID
     */
    function _decodeData(
        bytes memory _data
    )
        internal
        pure
        returns (
            address sender,
            address receiver,
            uint256 amount,
            bytes32 prevId
        )
    {
        (sender, receiver, amount, prevId) = abi.decode(
            _data,
            (address, address, uint256, bytes32)
        );
    }

    /*//////////////////////////////////////////////////////////////
                             UPGRADEABILITY
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Authorize upgrade to new implementation
     * @param newImplementation Address of new implementation
     */
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override onlyRole(UPGRADE_ROLE) {
        if (newImplementation == address(0)) revert InvalidAddress();
    }

    /**
     * @notice Get contract version
     * @return Version string
     */
    function version() external pure returns (string memory) {
        return "1.0.0";
    }

    /*//////////////////////////////////////////////////////////////
                            STORAGE GAP
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Storage gap for future upgrades
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[44] private __gap;
}
