// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title X402FeeSplitter
 * @author Silverback DeFi
 * @notice Atomically splits x402 payments between endpoint providers and facilitator treasury
 * @dev Called by authorized facilitators after Permit2 transfer to split payments
 *
 * Security Features:
 * - Ownable2Step: Two-step ownership transfer to prevent accidental transfers
 * - ReentrancyGuard: Prevents reentrancy attacks on splitPayment
 * - Pausable: Emergency circuit breaker
 * - Access Control: Only authorized facilitators can call splitPayment
 * - SafeERC20: Safe token transfers
 * - Input Validation: Comprehensive checks on all inputs
 * - Fee Cap: Maximum 10% fee to prevent misconfiguration
 * - Token Whitelist: Optional whitelist mode for additional safety
 *
 * Flow:
 * 1. Client signs Permit2 authorization with receiver = this contract
 * 2. Facilitator calls Permit2.permitWitnessTransferFrom (tokens go to this contract)
 * 3. Facilitator calls splitPayment() to distribute funds atomically
 *
 * Fee Structure (configurable per token):
 * - BACK token: 0% (fee-exempt to drive adoption)
 * - Stablecoins (USDC, USDT, DAI, USDbC): 0.1%
 * - Volatile (VIRTUAL): 0.1%
 * - Blue-chips (WETH, cbBTC): 0.25%
 */
contract X402FeeSplitter is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ============================================================================
    // Constants
    // ============================================================================

    /// @notice Maximum fee in basis points (10% = 1000 bps)
    uint256 public constant MAX_FEE_BPS = 1000;

    /// @notice Minimum payment amount to prevent dust (1 unit)
    uint256 public constant MIN_AMOUNT = 1;

    /// @notice Maximum single settlement in USD (with 6 decimals, like USDC)
    /// @dev Start conservative, increase as confidence grows. 0 = unlimited.
    uint256 public maxSettlementAmount;

    // ============================================================================
    // State Variables
    // ============================================================================

    /// @notice Treasury address that receives fees
    address public treasury;

    /// @notice Fee basis points per token (100 = 1%, 10 = 0.1%, 25 = 0.25%)
    mapping(address => uint256) public tokenFeeBps;

    /// @notice Track which tokens have been explicitly configured
    mapping(address => bool) public tokenConfigured;

    /// @notice Default fee for unlisted tokens (in basis points)
    uint256 public defaultFeeBps;

    /// @notice Authorized facilitators that can call splitPayment
    mapping(address => bool) public authorizedFacilitators;

    /// @notice Number of authorized facilitators
    uint256 public facilitatorCount;

    /// @notice Accumulated fees per token (for analytics)
    mapping(address => uint256) public collectedFees;

    /// @notice Total settlements processed
    uint256 public totalSettlements;

    /// @notice Total value settled per token (gross amounts)
    mapping(address => uint256) public totalVolumeByToken;

    /// @notice Enable whitelist-only mode for tokens
    bool public whitelistMode;

    /// @notice Whitelisted tokens (only used if whitelistMode = true)
    mapping(address => bool) public tokenWhitelisted;

    // ============================================================================
    // Events
    // ============================================================================

    event PaymentSplit(
        address indexed token,
        address indexed payer,
        address indexed recipient,
        uint256 grossAmount,
        uint256 netAmount,
        uint256 fee,
        address facilitator
    );

    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event TokenFeeUpdated(address indexed token, uint256 oldFeeBps, uint256 newFeeBps);
    event DefaultFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event FacilitatorUpdated(address indexed facilitator, bool authorized);
    event TokenWhitelistUpdated(address indexed token, bool whitelisted);
    event WhitelistModeUpdated(bool enabled);
    event EmergencyWithdraw(address indexed token, address indexed to, uint256 amount);
    event MaxSettlementUpdated(uint256 oldMax, uint256 newMax);

    // ============================================================================
    // Errors
    // ============================================================================

    error InvalidTreasury();
    error InvalidRecipient();
    error InvalidToken();
    error InvalidAmount();
    error FeeTooHigh();
    error LengthMismatch();
    error NotAuthorizedFacilitator();
    error TokenNotWhitelisted();
    error InsufficientBalance();
    error AmountExceedsLimit();

    // ============================================================================
    // Modifiers
    // ============================================================================

    modifier onlyFacilitator() {
        if (!authorizedFacilitators[msg.sender]) revert NotAuthorizedFacilitator();
        _;
    }

    // ============================================================================
    // Constructor
    // ============================================================================

    /**
     * @notice Initialize the fee splitter
     * @param _treasury Address to receive fees (cannot be zero)
     * @param _defaultFeeBps Default fee in basis points (max 1000 = 10%)
     * @param _initialFacilitator Initial authorized facilitator (can be zero for later setup)
     */
    constructor(
        address _treasury,
        uint256 _defaultFeeBps,
        address _initialFacilitator
    ) Ownable(msg.sender) {
        if (_treasury == address(0)) revert InvalidTreasury();
        if (_defaultFeeBps > MAX_FEE_BPS) revert FeeTooHigh();

        treasury = _treasury;
        defaultFeeBps = _defaultFeeBps;

        // Authorize initial facilitator if provided
        if (_initialFacilitator != address(0)) {
            authorizedFacilitators[_initialFacilitator] = true;
            facilitatorCount = 1;
            emit FacilitatorUpdated(_initialFacilitator, true);
        }
    }

    // ============================================================================
    // Core Functions
    // ============================================================================

    /**
     * @notice Split a payment between recipient and treasury
     * @dev Only authorized facilitators can call this. Contract must hold sufficient tokens.
     * @param token The ERC20 token address
     * @param payer Original payer (for event logging, not validated)
     * @param recipient Endpoint wallet to receive net payment (cannot be zero or this contract)
     * @param amount Gross amount to split (must be > 0)
     * @return netAmount Amount sent to recipient
     * @return feeAmount Amount sent to treasury
     */
    function splitPayment(
        address token,
        address payer,
        address recipient,
        uint256 amount
    ) external nonReentrant whenNotPaused onlyFacilitator returns (uint256 netAmount, uint256 feeAmount) {
        // Input validation
        if (token == address(0)) revert InvalidToken();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        if (amount < MIN_AMOUNT) revert InvalidAmount();

        // Check whitelist if enabled
        if (whitelistMode && !tokenWhitelisted[token]) revert TokenNotWhitelisted();

        // Check max settlement limit (0 = unlimited)
        if (maxSettlementAmount > 0 && amount > maxSettlementAmount) revert AmountExceedsLimit();

        // Verify contract has sufficient balance
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance < amount) revert InsufficientBalance();

        // Get fee for this token
        uint256 feeBps = getTokenFee(token);

        // Calculate fee (rounded down, safe from overflow with MAX_FEE_BPS cap)
        feeAmount = (amount * feeBps) / 10000;
        netAmount = amount - feeAmount;

        // Transfer net amount to recipient
        IERC20(token).safeTransfer(recipient, netAmount);

        // Transfer fee to treasury (if any)
        if (feeAmount > 0) {
            IERC20(token).safeTransfer(treasury, feeAmount);
            collectedFees[token] += feeAmount;
        }

        // Update stats
        totalSettlements++;
        totalVolumeByToken[token] += amount;

        emit PaymentSplit(token, payer, recipient, amount, netAmount, feeAmount, msg.sender);

        return (netAmount, feeAmount);
    }

    /**
     * @notice Get fee basis points for a token
     * @param token Token address
     * @return Fee in basis points (0 = exempt, 10 = 0.1%, 25 = 0.25%, etc.)
     */
    function getTokenFee(address token) public view returns (uint256) {
        // If explicitly configured (including 0 for exempt), use that value
        if (tokenConfigured[token]) {
            return tokenFeeBps[token];
        }
        // Otherwise use default
        return defaultFeeBps;
    }

    /**
     * @notice Calculate fee for a given amount (view function for quotes)
     * @param token Token address
     * @param amount Gross amount
     * @return netAmount Amount after fee
     * @return feeAmount Fee amount
     */
    function calculateSplit(
        address token,
        uint256 amount
    ) external view returns (uint256 netAmount, uint256 feeAmount) {
        uint256 feeBps = getTokenFee(token);
        feeAmount = (amount * feeBps) / 10000;
        netAmount = amount - feeAmount;
    }

    // ============================================================================
    // Facilitator Management
    // ============================================================================

    /**
     * @notice Add or remove an authorized facilitator
     * @param facilitator Address to authorize/deauthorize
     * @param authorized True to authorize, false to revoke
     */
    function setFacilitator(address facilitator, bool authorized) external onlyOwner {
        if (facilitator == address(0)) revert InvalidRecipient();

        bool wasAuthorized = authorizedFacilitators[facilitator];
        if (wasAuthorized == authorized) return; // No change

        authorizedFacilitators[facilitator] = authorized;

        if (authorized) {
            facilitatorCount++;
        } else {
            facilitatorCount--;
        }

        emit FacilitatorUpdated(facilitator, authorized);
    }

    // ============================================================================
    // Token Fee Configuration
    // ============================================================================

    /**
     * @notice Set fee for a specific token
     * @param token Token address (can set fee for any token)
     * @param feeBps Fee in basis points (0 = exempt, max 1000 = 10%)
     */
    function setTokenFee(address token, uint256 feeBps) external onlyOwner {
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh();

        uint256 oldFee = tokenFeeBps[token];
        tokenFeeBps[token] = feeBps;
        tokenConfigured[token] = true;

        emit TokenFeeUpdated(token, oldFee, feeBps);
    }

    /**
     * @notice Batch set fees for multiple tokens
     * @param tokens Array of token addresses
     * @param feesBps Array of fees in basis points
     */
    function setTokenFeesBatch(
        address[] calldata tokens,
        uint256[] calldata feesBps
    ) external onlyOwner {
        if (tokens.length != feesBps.length) revert LengthMismatch();

        for (uint256 i = 0; i < tokens.length; i++) {
            if (feesBps[i] > MAX_FEE_BPS) revert FeeTooHigh();

            uint256 oldFee = tokenFeeBps[tokens[i]];
            tokenFeeBps[tokens[i]] = feesBps[i];
            tokenConfigured[tokens[i]] = true;

            emit TokenFeeUpdated(tokens[i], oldFee, feesBps[i]);
        }
    }

    /**
     * @notice Update default fee for unlisted tokens
     * @param feeBps Fee in basis points (max 1000 = 10%)
     */
    function setDefaultFee(uint256 feeBps) external onlyOwner {
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh();

        uint256 oldFee = defaultFeeBps;
        defaultFeeBps = feeBps;

        emit DefaultFeeUpdated(oldFee, feeBps);
    }

    // ============================================================================
    // Token Whitelist
    // ============================================================================

    /**
     * @notice Enable or disable whitelist mode
     * @param enabled True to require tokens to be whitelisted
     */
    function setWhitelistMode(bool enabled) external onlyOwner {
        whitelistMode = enabled;
        emit WhitelistModeUpdated(enabled);
    }

    /**
     * @notice Add or remove a token from whitelist
     * @param token Token address
     * @param whitelisted True to whitelist, false to remove
     */
    function setTokenWhitelisted(address token, bool whitelisted) external onlyOwner {
        tokenWhitelisted[token] = whitelisted;
        emit TokenWhitelistUpdated(token, whitelisted);
    }

    /**
     * @notice Batch whitelist multiple tokens
     * @param tokens Array of token addresses
     * @param whitelisted True to whitelist all, false to remove all
     */
    function setTokensWhitelistedBatch(address[] calldata tokens, bool whitelisted) external onlyOwner {
        for (uint256 i = 0; i < tokens.length; i++) {
            tokenWhitelisted[tokens[i]] = whitelisted;
            emit TokenWhitelistUpdated(tokens[i], whitelisted);
        }
    }

    // ============================================================================
    // Treasury Management
    // ============================================================================

    /**
     * @notice Update treasury address
     * @param _treasury New treasury address (cannot be zero)
     */
    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert InvalidTreasury();

        address oldTreasury = treasury;
        treasury = _treasury;

        emit TreasuryUpdated(oldTreasury, _treasury);
    }

    // ============================================================================
    // Emergency Functions
    // ============================================================================

    /**
     * @notice Set maximum settlement amount (safety limit)
     * @dev Start low, increase as confidence grows. 0 = unlimited.
     * @param _maxAmount Maximum amount per settlement (in token base units)
     */
    function setMaxSettlement(uint256 _maxAmount) external onlyOwner {
        uint256 oldMax = maxSettlementAmount;
        maxSettlementAmount = _maxAmount;
        emit MaxSettlementUpdated(oldMax, _maxAmount);
    }

    /**
     * @notice Pause all settlements (emergency only)
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause settlements
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Emergency withdraw stuck tokens to treasury
     * @dev Only for recovery of stuck funds, not normal operation
     * @param token Token address
     * @param amount Amount to withdraw (use type(uint256).max for all)
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 withdrawAmount = amount > balance ? balance : amount;

        IERC20(token).safeTransfer(treasury, withdrawAmount);

        emit EmergencyWithdraw(token, treasury, withdrawAmount);
    }

    /**
     * @notice Emergency withdraw to a specific address
     * @dev For extreme emergencies where treasury might be compromised
     * @param token Token address
     * @param to Recipient address
     * @param amount Amount to withdraw
     */
    function emergencyWithdrawTo(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidRecipient();

        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 withdrawAmount = amount > balance ? balance : amount;

        IERC20(token).safeTransfer(to, withdrawAmount);

        emit EmergencyWithdraw(token, to, withdrawAmount);
    }

    // ============================================================================
    // View Functions
    // ============================================================================

    /**
     * @notice Get contract statistics
     */
    function getStats() external view returns (
        uint256 settlements,
        address treasuryAddr,
        uint256 defaultFee,
        uint256 numFacilitators,
        bool isPaused,
        bool isWhitelistMode
    ) {
        return (
            totalSettlements,
            treasury,
            defaultFeeBps,
            facilitatorCount,
            paused(),
            whitelistMode
        );
    }

    /**
     * @notice Get detailed token statistics
     * @param token Token address
     */
    function getTokenStats(address token) external view returns (
        uint256 feeBps,
        bool configured,
        bool whitelisted,
        uint256 feesCollected,
        uint256 volumeSettled
    ) {
        return (
            getTokenFee(token),
            tokenConfigured[token],
            tokenWhitelisted[token],
            collectedFees[token],
            totalVolumeByToken[token]
        );
    }

    /**
     * @notice Check if an address is an authorized facilitator
     * @param facilitator Address to check
     */
    function isFacilitator(address facilitator) external view returns (bool) {
        return authorizedFacilitators[facilitator];
    }
}
