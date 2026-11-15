// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Import OpenZeppelin libraries
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

// Import Chainlink oracle interface
import "./interfaces/AggregatorV3Interface.sol";

// Custom error definitions
error InvalidAmount();
error InvalidInterestRate();
error InvalidDuration();
error InvalidCollateral();
error InsufficientCollateralValue();
error TokenNotAllowed();
error InvalidLoanState();
error LoanNotExpired();
error LoanAlreadyRepaid();
error SelfFunding();
error IncorrectFundingAmount();
error StaleData();
error PriceFeedNotAvailable();
error InvalidPriceData();
error InvalidAddress();
error InvalidLoanId();
error InvalidParameter();
error Unauthorized();
error TooManyActiveLoans();
error LoanTooLarge();
error InsufficientUnlockedCollateral();
error ChangeNotQueued();
error TimelockNotElapsed();
error ChangeAlreadyExecuted();
error InvalidOfferId();
error OfferExpired();
error OfferNotExpired();
error InsufficientUnlockedETH();
error CollateralSufficient();
error NoDebtToLiquidate();
error TokenDecimalsNotSet();

/**
 * @title SocialLendingWithCollateral
 * @notice Decentralized peer-to-peer ETH lending protocol backed by ERC-20 collateral and Chainlink price feeds.
 * @dev Uses ReentrancyGuard, Ownable, Pausable, and Checks-Effects-Interactions for state transitions.
 */
contract SocialLendingWithCollateral is ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;
    using Address for address payable;

    // Constants
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant MAX_INTEREST_RATE = 2000; // 20%
    uint256 public constant MAX_PLATFORM_FEE = 500;  // 5%
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant PRICE_FEED_TIMEOUT = 1 hours; // Price feed staleness timeout
    uint256 public constant MAX_LOAN_DURATION = 365 days; // Maximum loan duration
    uint256 public constant MAX_GRACE_PERIOD = 30 days; // Maximum grace period

    /// @notice Lifecycle states of a loan.
    enum LoanState { Requested, Funded, Repaid, Defaulted, Cancelled, Liquidated }

    /// @notice Lifecycle states of a lender-initiated loan offer.
    enum OfferState { Created, Accepted, Cancelled, Expired }

    struct LoanOffer {
        address payable lender;
        uint256 principalAmount;
        uint256 maxInterestRate;
        uint256 minDuration;
        uint256 maxDuration;
        address requiredCollateralToken;
        uint256 minCollateralRatio;
        OfferState state;
        uint256 createdAt;
        uint256 expiresAt;
    }

    /// @notice Core loan data packed to minimize storage slots.
    struct Loan {
        // Slot 1: borrower (20) + state (1) + interestRate (2) = 23 bytes
        address payable borrower;
        LoanState state;         // Loan state (1 byte)
        uint16 interestRate;     // Interest rate in basis points (2 bytes)

        // Slot 2: lender (20)
        address payable lender;

        // Slot 3
        address collateralToken; // Collateral token address

        // Slot 4
        uint256 principalAmount; // Principal amount in wei

        // Slot 5
        uint256 repaymentAmount; // Total repayment amount in wei

        // Slot 6
        uint256 duration;        // Duration in seconds

        // Slot 7
        uint256 startTime;       // Funding start timestamp

        // Slot 8
        uint256 collateralAmount;// Collateral amount

        // Slot 9
        uint256 remainingRepaymentAmount; // Remaining repayment amount in wei
    }

    /// @notice Mapping from loan ID to Loan struct.
    mapping(uint256 => Loan) public loans;
    uint256 public loanCount;

    // Per-user loan ID indices (Gas Optimization)
    mapping(address => uint256[]) private _borrowerLoanIds;
    mapping(address => uint256[]) private _lenderLoanIds;

    // Aggregate statistics counters (Gas Optimization)
    uint256 public activeLoansCount;
    uint256 public repaidLoansCount;
    uint256 public defaultedLoansCount;
    uint256 public cancelledLoansCount;
    uint256 public liquidatedLoansCount;

    // Timelock governance settings
    uint256 public constant TIMELOCK_DELAY = 48 hours;
    bool public timelockEnabled;

    struct PendingChange {
        bytes4 functionSelector;
        bytes params;
        bytes32 callKey;
        uint256 executeAfter;
        bool executed;
    }

    mapping(bytes32 => PendingChange) public pendingChanges;
    mapping(bytes32 => bytes32) private _queuedOperationByCall;

    // Active loan count per user
    mapping(address => uint256) public borrowerActiveLoans;
    mapping(address => uint256) public lenderActiveLoans;

    // Allowed collateral token registry
    mapping(address => bool) public allowedCollateralTokens;

    // Collateral token decimals
    mapping(address => uint8) public collateralTokenDecimals;
    mapping(address => bool) public collateralDecimalsSet;

    // Oracle mapping (collateral token => price feed)
    mapping(address => address) public priceFeeds;

    // Platform fee in basis points
    uint256 public platformFee = 100; // 1%
    address public feeRecipient;

    // Locked collateral balance per token
    mapping(address => uint256) public lockedCollateral;

    // Lender-initiated loan offer storage
    mapping(uint256 => LoanOffer) public loanOffers;
    uint256 public offerCount;

    // Pending ETH withdrawals (pull-payment fallback) and locked ETH
    mapping(address => uint256) public pendingETHWithdrawals;
    uint256 public lockedETH;

    // Borrowing limits
    uint256 public maxLoanAmount = 10 ether;
    uint256 public maxActiveLoansPerBorrower = 3;

    // Collateral ratio in basis points (e.g. 15000 = 150%)
    uint256 public collateralRatio = 15000;
    uint256 public constant MIN_COLLATERAL_RATIO = 10000; // 100%
    uint256 public constant MAX_COLLATERAL_RATIO = 20000; // 200%

    /// @notice On-chain credit score and reputation record per user.
    struct UserReputation {
        uint256 totalLoans;
        uint256 repaidLoans;
        uint256 defaultedLoans;
        uint256 totalBorrowedAmount;
        uint256 totalRepaidAmount;
        uint256 lastActivityTimestamp;
    }

    mapping(address => UserReputation) public userReputations;

    // Grace period and liquidation parameters
    uint256 public gracePeriod = 3 days;
    uint256 public liquidationThreshold = 12000; // 120%
    uint256 public liquidationBonus = 500;       // 5%

    // Events
    event LoanRequested(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 amount,
        uint256 interestRate,
        uint256 duration,
        address collateralToken,
        uint256 collateralAmount
    );
    event LoanFunded(uint256 indexed loanId, address indexed lender);
    event LoanPartiallyRepaid(uint256 indexed loanId, address indexed borrower, uint256 amountRepaid, uint256 remainingAmount);
    event LoanRepaid(uint256 indexed loanId, address indexed borrower, address indexed lender, uint256 repaymentAmount);
    event DefaultDeclared(uint256 indexed loanId, address indexed lender);
    event LoanCancelled(uint256 indexed loanId, address indexed borrower);
    event PriceFeedUpdated(address indexed token, address indexed priceFeed);
    event PlatformFeeUpdated(uint256 newFee);
    event FeeRecipientUpdated(address indexed newRecipient);
    event CollateralRatioUpdated(uint256 newRatio);
    event CollateralTokenStatusUpdated(address indexed token, bool allowed);
    event CollateralTokenDecimalsUpdated(address indexed token, uint8 decimals);

    event MaxActiveLoansPerBorrowerUpdated(uint256 newMax);
    event MaxLoanAmountUpdated(uint256 newMaxAmount);
    event TimelockEnabled();
    event ChangeQueued(bytes32 indexed operationHash, bytes4 indexed functionSelector, bytes params, uint256 executeAfter);
    event ChangeExecuted(bytes32 indexed operationHash);
    event ChangeCancelled(bytes32 indexed operationHash);
    event LoanOfferCreated(uint256 indexed offerId, address indexed lender, uint256 amount, uint256 maxInterestRate);
    event LoanOfferAccepted(uint256 indexed offerId, uint256 indexed loanId, address indexed borrower);
    event LoanOfferCancelled(uint256 indexed offerId);
    event LoanOfferExpired(uint256 indexed offerId);
    event ReputationUpdated(address indexed user, uint256 totalLoans, uint256 repaidLoans, uint256 defaultedLoans);
    event GracePeriodUpdated(uint256 newGracePeriod);
    event LiquidationThresholdUpdated(uint256 newThreshold);
    event LoanLiquidated(
        uint256 indexed loanId,
        address indexed liquidator,
        uint256 collateralSeized,
        uint256 collateralReturnedToBorrower,
        uint256 debtRepaid
    );
    event ETHWithdrawalQueued(address indexed recipient, uint256 amount);
    event ETHWithdrawn(address indexed recipient, uint256 amount);
    event TokensRescued(address indexed token, uint256 amount, address indexed to);
    event ETHRescued(uint256 amount, address indexed to);

    /**
     * @notice Constructor to initialize the contract with the fee recipient
     * @param _feeRecipient The address to receive platform fees
     */
    constructor(address _feeRecipient) {
        if (_feeRecipient == address(0)) revert InvalidAddress();
        feeRecipient = _feeRecipient;
        _transferOwnership(msg.sender);
    }

    // ... (existing code for setCollateralRatio etc)

    function setMaxActiveLoansPerBorrower(uint256 _max) external onlyOwner {
        if (_max == 0) revert InvalidParameter();
        maxActiveLoansPerBorrower = _max;
        emit MaxActiveLoansPerBorrowerUpdated(_max);
    }

    function setMaxLoanAmount(uint256 _maxLoanAmount) external onlyOwner {
        if (_maxLoanAmount == 0) revert InvalidParameter();
        maxLoanAmount = _maxLoanAmount;
        emit MaxLoanAmountUpdated(_maxLoanAmount);
    }

    /**
     * @notice Allows the contract to receive ETH
     */
    receive() external payable {}

    /*
    Core Protocol Workflow:

    1. Loan Request
    - Borrower specifies loan terms and collateral token/amount.
    - Contract validates collateral value against collateralRatio.
    - Collateral tokens are transferred into escrow.

    2. Loan Funding
    - Lender funds the loan in ETH.
    - Platform fee is deducted and sent to feeRecipient.
    - Remaining principal is transferred to borrower.

    3. Repayment
    - Borrower may make partial or full repayments.
    - On full repayment, escrowed collateral is returned to borrower.

    4. Default Handling & Liquidation
    - Triggered by lender (declareDefault) or anyone (checkAndDeclareDefault) after duration + gracePeriod.
    - Undercollateralized loans can be liquidated via liquidate().

    Security Controls:
    - ReentrancyGuard on state-changing external functions
    - Pausable emergency stop (owner only)
    - Chainlink oracle staleness and sanity checks
    - 48-hour timelock governance for sensitive admin setters
    */

    /// @dev Restricts caller to the loan borrower.
    modifier onlyBorrower(uint256 loanId) {
        if (msg.sender != loans[loanId].borrower) revert Unauthorized();
        _;
    }

    /// @dev Restricts caller to the loan lender.
    modifier onlyLender(uint256 loanId) {
        if (msg.sender != loans[loanId].lender) revert Unauthorized();
        _;
    }

    /// @dev Validates that loanId exists.
    modifier validLoanId(uint256 loanId) {
        if (loanId >= loanCount) revert InvalidLoanId();
        _;
    }

    /// @dev Validates that offerId exists.
    modifier validOfferId(uint256 offerId) {
        if (offerId >= offerCount) revert InvalidOfferId();
        _;
    }

    /**
     * @notice Pauses the contract, disabling non-owner functions
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpauses the contract, enabling all functions
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Sets the allowed status for a collateral token
     * @param token The address of the collateral token
     * @param allowed Whether the token is allowed as collateral
     */
    function setCollateralTokenStatus(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert InvalidAddress();
        _consumeTimelock(msg.sig, abi.encode(token, allowed));
        allowedCollateralTokens[token] = allowed;
        if (allowed && !collateralDecimalsSet[token] && token.code.length > 0) {
            (bool ok, bytes memory data) = token.staticcall(
                abi.encodeWithSelector(IERC20Metadata.decimals.selector)
            );
            if (ok && data.length >= 32) {
                uint256 dec = abi.decode(data, (uint256));
                if (dec <= 18) {
                    collateralTokenDecimals[token] = uint8(dec);
                    collateralDecimalsSet[token] = true;
                    emit CollateralTokenDecimalsUpdated(token, uint8(dec));
                }
            }
        }
        emit CollateralTokenStatusUpdated(token, allowed);
    }

    /**
     * @notice Sets the decimal places for a collateral token
     * @param token The address of the collateral token
     * @param decimals The number of decimal places for the token
     */
    function setCollateralTokenDecimals(address token, uint8 decimals) external onlyOwner {
        if (token == address(0)) revert InvalidAddress();
        if (decimals > 18) revert InvalidParameter();
        _consumeTimelock(msg.sig, abi.encode(token, decimals));
        collateralTokenDecimals[token] = decimals;
        collateralDecimalsSet[token] = true;
        emit CollateralTokenDecimalsUpdated(token, decimals);
    }

    /**
     * @notice Sets the price feed for a collateral token
     * @param token The address of the collateral token
     * @param priceFeed The address of the price feed contract
     */
    function setPriceFeed(address token, address priceFeed) external onlyOwner {
        if (token == address(0) || priceFeed == address(0)) revert InvalidAddress();
        _consumeTimelock(msg.sig, abi.encode(token, priceFeed));
        priceFeeds[token] = priceFeed;
        emit PriceFeedUpdated(token, priceFeed);
    }

    /**
     * @notice Allows a borrower to request a loan by providing collateral
     * @param amount The principal amount of the loan in wei
     * @param interestRate The annual interest rate in basis points
     * @param duration The duration of the loan in seconds
     * @param collateralToken The address of the collateral token
     * @param collateralAmount The amount of collateral to deposit
     */
    function requestLoan(
        uint256 amount,
        uint256 interestRate,
        uint256 duration,
        address collateralToken,
        uint256 collateralAmount
    ) external nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();
        if (interestRate == 0 || interestRate > MAX_INTEREST_RATE) revert InvalidInterestRate();
        if (duration == 0 || duration > MAX_LOAN_DURATION) revert InvalidDuration();
        if (collateralAmount == 0) revert InvalidCollateral();
        if (collateralToken == address(0)) revert InvalidAddress();
        if (!allowedCollateralTokens[collateralToken]) revert TokenNotAllowed();

        if (amount > maxLoanAmount) revert LoanTooLarge();
        if (borrowerActiveLoans[msg.sender] >= maxActiveLoansPerBorrower) revert TooManyActiveLoans();

        // Deposit collateral and measure actual received amount (fee-on-transfer protection)
        uint256 balanceBefore = IERC20(collateralToken).balanceOf(address(this));
        IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), collateralAmount);
        uint256 actualCollateral = IERC20(collateralToken).balanceOf(address(this)) - balanceBefore;
        if (actualCollateral == 0) revert InvalidCollateral();

        // Calculate total repayment with simple interest using Math.mulDiv
        uint256 annualInterest = Math.mulDiv(amount, interestRate, BASIS_POINTS);
        uint256 interestAmount = Math.mulDiv(annualInterest, duration, SECONDS_PER_YEAR);
        uint256 repaymentAmount = amount + interestAmount;

        // Evaluate collateral value against total repayment amount
        uint256 collateralValueInETH = getCollateralValueInETH(collateralToken, actualCollateral);
        uint256 requiredCollateralValueInETH = Math.mulDiv(
            repaymentAmount,
            collateralRatio,
            BASIS_POINTS,
            Math.Rounding.Up
        );
        if (collateralValueInETH < requiredCollateralValueInETH) revert InsufficientCollateralValue();

        lockedCollateral[collateralToken] += actualCollateral;

        uint256 loanId = loanCount++;

        loans[loanId] = Loan({
            borrower: payable(msg.sender),
            lender: payable(address(0)),
            principalAmount: amount,
            interestRate: uint16(interestRate),
            repaymentAmount: repaymentAmount,
            duration: duration,
            startTime: 0,
            state: LoanState.Requested,
            collateralToken: collateralToken,
            collateralAmount: actualCollateral,
            remainingRepaymentAmount: repaymentAmount
        });

        borrowerActiveLoans[msg.sender]++;
        _borrowerLoanIds[msg.sender].push(loanId);

        emit LoanRequested(loanId, msg.sender, amount, interestRate, duration, collateralToken, actualCollateral);
    }

    /**
     * @notice Allows the borrower to cancel a loan request before it is funded
     * @param loanId The ID of the loan to cancel
     */
    function cancelLoanRequest(uint256 loanId) external nonReentrant validLoanId(loanId) onlyBorrower(loanId) whenNotPaused {
        Loan storage loan = loans[loanId];
        if (loan.state != LoanState.Requested) revert InvalidLoanState();

        // Update state before external calls (Checks-Effects-Interactions)
        loan.state = LoanState.Cancelled;
        borrowerActiveLoans[loan.borrower]--;
        cancelledLoansCount++;

        // Return collateral
        lockedCollateral[loan.collateralToken] -= loan.collateralAmount;
        IERC20(loan.collateralToken).safeTransfer(loan.borrower, loan.collateralAmount);

        emit LoanCancelled(loanId, loan.borrower);
    }

    /**
     * @notice Allows a lender to fund a loan request
     * @param loanId The ID of the loan to fund
     */
    function fundLoan(uint256 loanId) external payable nonReentrant validLoanId(loanId) whenNotPaused {
        Loan storage loan = loans[loanId];
        if (loan.state != LoanState.Requested) revert InvalidLoanState();
        if (msg.value != loan.principalAmount) revert IncorrectFundingAmount();
        if (loan.borrower == msg.sender) revert SelfFunding();

        // Update state before external calls (Checks-Effects-Interactions)
        loan.lender = payable(msg.sender);
        loan.startTime = block.timestamp;
        loan.state = LoanState.Funded;
        lenderActiveLoans[msg.sender]++;

        activeLoansCount++;
        _lenderLoanIds[msg.sender].push(loanId);

        UserReputation storage rep = userReputations[loan.borrower];
        rep.totalLoans++;
        rep.totalBorrowedAmount += loan.principalAmount;
        rep.lastActivityTimestamp = block.timestamp;
        emit ReputationUpdated(loan.borrower, rep.totalLoans, rep.repaidLoans, rep.defaultedLoans);

        // Calculate and transfer platform fee
        uint256 feeAmount = msg.value * platformFee / BASIS_POINTS;
        uint256 amountToBorrower = msg.value - feeAmount;

        // Transfer fee (queued for pull-payment if direct transfer fails)
        _safeTransferETHOrQueue(feeRecipient, feeAmount);

        // Transfer principal minus fee to borrower (queued on failure)
        _safeTransferETHOrQueue(loan.borrower, amountToBorrower);

        emit LoanFunded(loanId, msg.sender);
    }

    /**
     * @notice Allows the borrower to repay the loan, supporting partial repayments
     * @param loanId The ID of the loan to repay
     */
    function repayLoan(uint256 loanId) external payable nonReentrant validLoanId(loanId) onlyBorrower(loanId) whenNotPaused {
        Loan storage loan = loans[loanId];
        if (loan.state != LoanState.Funded) revert InvalidLoanState();
        if (msg.value == 0) revert InvalidAmount();

        uint256 amount = msg.value;
        uint256 excessAmount = 0;

        // Update state before external calls (Checks-Effects-Interactions)
        UserReputation storage rep = userReputations[loan.borrower];
        if (amount >= loan.remainingRepaymentAmount) {
            // Full repayment
            excessAmount = amount - loan.remainingRepaymentAmount;
            amount = loan.remainingRepaymentAmount;
            loan.remainingRepaymentAmount = 0;
            loan.state = LoanState.Repaid;
            borrowerActiveLoans[loan.borrower]--;
            lenderActiveLoans[loan.lender]--;

            activeLoansCount--;
            repaidLoansCount++;

            rep.repaidLoans++;
            rep.totalRepaidAmount += amount;
            rep.lastActivityTimestamp = block.timestamp;
            emit ReputationUpdated(loan.borrower, rep.totalLoans, rep.repaidLoans, rep.defaultedLoans);

            // Return collateral
            lockedCollateral[loan.collateralToken] -= loan.collateralAmount;
            IERC20(loan.collateralToken).safeTransfer(loan.borrower, loan.collateralAmount);

            emit LoanRepaid(loanId, loan.borrower, loan.lender, amount);
        } else {
            // Partial repayment
            loan.remainingRepaymentAmount -= amount;

            rep.totalRepaidAmount += amount;
            rep.lastActivityTimestamp = block.timestamp;
            emit ReputationUpdated(loan.borrower, rep.totalLoans, rep.repaidLoans, rep.defaultedLoans);

            emit LoanPartiallyRepaid(loanId, loan.borrower, amount, loan.remainingRepaymentAmount);
        }

        // Transfer repayment to lender (queued on failure)
        _safeTransferETHOrQueue(loan.lender, amount);

        // Refund excess payment to borrower (queued on failure)
        if (excessAmount > 0) {
            _safeTransferETHOrQueue(loan.borrower, excessAmount);
        }
    }

    /**
     * @notice Withdraws queued ETH that failed direct push transfer
     */
    function withdrawETH() external nonReentrant {
        uint256 amount = pendingETHWithdrawals[msg.sender];
        if (amount == 0) revert InvalidAmount();
        pendingETHWithdrawals[msg.sender] = 0;
        lockedETH -= amount;
        payable(msg.sender).sendValue(amount);
        emit ETHWithdrawn(msg.sender, amount);
    }

    /**
     * @dev Attempts bounded-gas ETH transfer and falls back to pull-payment queue on failure.
     */
    function _safeTransferETHOrQueue(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool success, ) = payable(to).call{value: amount, gas: 50_000}("");
        if (!success) {
            pendingETHWithdrawals[to] += amount;
            lockedETH += amount;
            emit ETHWithdrawalQueued(to, amount);
        }
    }

    /**
     * @notice Allows the lender to declare default and claim collateral if the loan is overdue
     * @param loanId The ID of the loan to declare default
     */
    function declareDefault(uint256 loanId) external nonReentrant validLoanId(loanId) onlyLender(loanId) whenNotPaused {
        Loan storage loan = loans[loanId];
        if (loan.state != LoanState.Funded) revert InvalidLoanState();
        if (block.timestamp <= loan.startTime + loan.duration + gracePeriod) revert LoanNotExpired();

        // Update state before external calls (Checks-Effects-Interactions)
        loan.state = LoanState.Defaulted;
        borrowerActiveLoans[loan.borrower]--;
        lenderActiveLoans[loan.lender]--;

        activeLoansCount--;
        defaultedLoansCount++;

        UserReputation storage rep = userReputations[loan.borrower];
        rep.defaultedLoans++;
        rep.lastActivityTimestamp = block.timestamp;
        emit ReputationUpdated(loan.borrower, rep.totalLoans, rep.repaidLoans, rep.defaultedLoans);

        // Transfer collateral to lender
        lockedCollateral[loan.collateralToken] -= loan.collateralAmount;
        IERC20(loan.collateralToken).safeTransfer(loan.lender, loan.collateralAmount);

        emit DefaultDeclared(loanId, loan.lender);
    }

    /**
     * @notice Automatically checks and declares default for overdue loans, claimable by anyone
     * @param loanId The ID of the loan to check and declare default
     */
    function checkAndDeclareDefault(uint256 loanId) external nonReentrant validLoanId(loanId) whenNotPaused {
        Loan storage loan = loans[loanId];
        if (loan.state != LoanState.Funded) revert InvalidLoanState();
        if (block.timestamp <= loan.startTime + loan.duration + gracePeriod) revert LoanNotExpired();

        // Update state before external calls (Checks-Effects-Interactions)
        loan.state = LoanState.Defaulted;
        borrowerActiveLoans[loan.borrower]--;
        lenderActiveLoans[loan.lender]--;

        activeLoansCount--;
        defaultedLoansCount++;

        UserReputation storage rep = userReputations[loan.borrower];
        rep.defaultedLoans++;
        rep.lastActivityTimestamp = block.timestamp;
        emit ReputationUpdated(loan.borrower, rep.totalLoans, rep.repaidLoans, rep.defaultedLoans);

        // Transfer collateral to lender
        lockedCollateral[loan.collateralToken] -= loan.collateralAmount;
        IERC20(loan.collateralToken).safeTransfer(loan.lender, loan.collateralAmount);

        emit DefaultDeclared(loanId, loan.lender);
    }

    /**
     * @notice Liquidates an undercollateralized funded loan
     * @param loanId The ID of the loan to liquidate
     */
    function liquidate(uint256 loanId) external payable nonReentrant validLoanId(loanId) whenNotPaused {
        Loan storage loan = loans[loanId];
        if (loan.state != LoanState.Funded) revert InvalidLoanState();
        if (loan.remainingRepaymentAmount == 0) revert NoDebtToLiquidate();

        uint256 collateralValue = getCollateralValueInETH(loan.collateralToken, loan.collateralAmount);
        uint256 ratio = Math.mulDiv(collateralValue, BASIS_POINTS, loan.remainingRepaymentAmount);
        if (ratio >= liquidationThreshold) revert CollateralSufficient();

        uint256 debtRepaid = loan.remainingRepaymentAmount;
        if (msg.value < debtRepaid) revert InvalidAmount();

        uint256 excessETH = msg.value - debtRepaid;
        uint256 seizeValue = Math.mulDiv(debtRepaid, BASIS_POINTS + liquidationBonus, BASIS_POINTS);
        uint256 seizeAmount = seizeValue >= collateralValue
            ? loan.collateralAmount
            : Math.mulDiv(loan.collateralAmount, seizeValue, collateralValue);
        uint256 surplusCollateral = loan.collateralAmount - seizeAmount;

        // Update state before external calls (Checks-Effects-Interactions)
        loan.remainingRepaymentAmount = 0;
        loan.state = LoanState.Liquidated;
        borrowerActiveLoans[loan.borrower]--;
        lenderActiveLoans[loan.lender]--;
        activeLoansCount--;
        liquidatedLoansCount++;
        lockedCollateral[loan.collateralToken] -= loan.collateralAmount;

        // Transfer ETH and collateral
        loan.lender.sendValue(debtRepaid);
        IERC20(loan.collateralToken).safeTransfer(msg.sender, seizeAmount);
        if (surplusCollateral > 0) {
            IERC20(loan.collateralToken).safeTransfer(loan.borrower, surplusCollateral);
        }
        if (excessETH > 0) {
            payable(msg.sender).sendValue(excessETH);
        }

        emit LoanLiquidated(loanId, msg.sender, seizeAmount, surplusCollateral, debtRepaid);
    }

    /**
     * @notice Gets the value of collateral in ETH
     * @param collateralToken The address of the collateral token
     * @param collateralAmount The amount of collateral
     * @return The value in ETH
     */
    function getCollateralValueInETH(address collateralToken, uint256 collateralAmount) public view returns (uint256) {
        address priceFeedAddress = priceFeeds[collateralToken];
        if (priceFeedAddress == address(0)) revert PriceFeedNotAvailable();

        AggregatorV3Interface priceFeed = AggregatorV3Interface(priceFeedAddress);

        // Fetch and validate oracle price data
        (
            uint80 roundId,
            int256 price,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = priceFeed.latestRoundData();

        // Validate oracle price data
        if (price <= 0) revert InvalidPriceData();
        if (startedAt == 0 || updatedAt == 0 || updatedAt < startedAt || updatedAt > block.timestamp) {
            revert InvalidPriceData();
        }
        if (block.timestamp - updatedAt > PRICE_FEED_TIMEOUT) revert StaleData();
        if (answeredInRound < roundId) revert StaleData();

        if (!collateralDecimalsSet[collateralToken]) revert TokenDecimalsNotSet();

        uint8 decimals = priceFeed.decimals();
        uint8 tokenDecimals = collateralTokenDecimals[collateralToken];

        // Normalize collateral amount using token decimals and Math.mulDiv
        uint256 normalizedAmount = Math.mulDiv(collateralAmount, 1e18, 10 ** uint256(tokenDecimals));
        uint256 collateralValueInETH = Math.mulDiv(normalizedAmount, uint256(price), 10 ** uint256(decimals));
        return collateralValueInETH;
    }

    /**
     * @notice Gets the list of active loan IDs for a borrower
     * @param borrower The address of the borrower
     * @return Array of loan IDs
     */
    function getBorrowerLoans(address borrower) external view returns (uint256[] memory) {
        uint256[] storage allLoanIds = _borrowerLoanIds[borrower];
        uint256 activeCount = 0;

        // First pass: count matching loans
        for (uint256 i = 0; i < allLoanIds.length; i++) {
            LoanState state = loans[allLoanIds[i]].state;
            if (state == LoanState.Requested || state == LoanState.Funded) {
                activeCount++;
            }
        }

        uint256[] memory activeLoanIds = new uint256[](activeCount);
        uint256 counter = 0;

        // Second pass: populate result array
        for (uint256 i = 0; i < allLoanIds.length; i++) {
            LoanState state = loans[allLoanIds[i]].state;
            if (state == LoanState.Requested || state == LoanState.Funded) {
                activeLoanIds[counter] = allLoanIds[i];
                counter++;
            }
        }

        return activeLoanIds;
    }

    /**
     * @notice Gets the current collateralization ratio for a funded loan in basis points (10000 = 100%).
     * @param loanId The ID of the loan.
     * @return The current collateralization ratio in basis points.
     */
    function getCollateralizationRatio(uint256 loanId) external view validLoanId(loanId) returns (uint256) {
        Loan storage loan = loans[loanId];
        if (loan.state != LoanState.Funded) revert InvalidLoanState();

        uint256 collateralValue = getCollateralValueInETH(loan.collateralToken, loan.collateralAmount);
        return Math.mulDiv(collateralValue, BASIS_POINTS, loan.remainingRepaymentAmount);
    }

    /**
     * @notice Gets the list of funded loan IDs for a lender
     * @param lender The address of the lender
     * @return Array of loan IDs
     */
    function getLenderLoans(address lender) external view returns (uint256[] memory) {
        uint256[] storage allLoanIds = _lenderLoanIds[lender];
        uint256 activeCount = 0;

        // First pass: count matching loans
        for (uint256 i = 0; i < allLoanIds.length; i++) {
            if (loans[allLoanIds[i]].state == LoanState.Funded) {
                activeCount++;
            }
        }

        uint256[] memory activeLoanIds = new uint256[](activeCount);
        uint256 counter = 0;

        // Second pass: populate result array
        for (uint256 i = 0; i < allLoanIds.length; i++) {
            if (loans[allLoanIds[i]].state == LoanState.Funded) {
                activeLoanIds[counter] = allLoanIds[i];
                counter++;
            }
        }

        return activeLoanIds;
    }

    /**
     * @notice Permanently enables the 48-hour timelock for sensitive admin setters.
     */
    function enableTimelock() external onlyOwner {
        if (timelockEnabled) revert InvalidParameter();
        timelockEnabled = true;
        emit TimelockEnabled();
    }

    /**
     * @notice Queues a timelocked admin parameter change.
     */
    function queueChange(
        bytes4 functionSelector,
        bytes calldata params
    ) external onlyOwner returns (bytes32 operationHash) {
        if (functionSelector == bytes4(0)) revert InvalidParameter();
        uint256 executeAfter = block.timestamp + TIMELOCK_DELAY;
        bytes32 callKey = keccak256(abi.encode(functionSelector, params));
        operationHash = keccak256(abi.encode(functionSelector, params, executeAfter));
        pendingChanges[operationHash] = PendingChange({
            functionSelector: functionSelector,
            params: params,
            callKey: callKey,
            executeAfter: executeAfter,
            executed: false
        });
        _queuedOperationByCall[callKey] = operationHash;
        emit ChangeQueued(operationHash, functionSelector, params, executeAfter);
    }

    /**
     * @notice Cancels a queued timelock change before execution.
     */
    function cancelChange(bytes32 operationHash) external onlyOwner {
        PendingChange storage change = pendingChanges[operationHash];
        if (change.executeAfter == 0) revert ChangeNotQueued();
        if (change.executed) revert ChangeAlreadyExecuted();

        bytes32 callKey = change.callKey;
        if (_queuedOperationByCall[callKey] == operationHash) {
            delete _queuedOperationByCall[callKey];
        }
        delete pendingChanges[operationHash];
        emit ChangeCancelled(operationHash);
    }

    /**
     * @dev Verifies and consumes a queued timelock operation when timelock is enabled.
     */
    function _consumeTimelock(bytes4 functionSelector, bytes memory params) internal {
        if (!timelockEnabled) return;

        bytes32 callKey = keccak256(abi.encode(functionSelector, params));
        bytes32 operationHash = _queuedOperationByCall[callKey];
        PendingChange storage change = pendingChanges[operationHash];

        if (change.executeAfter == 0) revert ChangeNotQueued();
        if (block.timestamp < change.executeAfter) revert TimelockNotElapsed();

        change.executed = true;
        delete _queuedOperationByCall[callKey];
        emit ChangeExecuted(operationHash);
    }

    /**
     * @notice Sets the platform fee in basis points.
     * @param _platformFee The new platform fee (must be <= MAX_PLATFORM_FEE).
     */
    function setPlatformFee(uint256 _platformFee) external onlyOwner {
        if (_platformFee > MAX_PLATFORM_FEE) revert InvalidParameter();
        _consumeTimelock(msg.sig, abi.encode(_platformFee));
        platformFee = _platformFee;
        emit PlatformFeeUpdated(_platformFee);
    }

    /**
     * @notice Sets the platform fee recipient address.
     * @param _feeRecipient The new non-zero fee recipient address.
     */
    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        if (_feeRecipient == address(0)) revert InvalidAddress();
        _consumeTimelock(msg.sig, abi.encode(_feeRecipient));
        feeRecipient = _feeRecipient;
        emit FeeRecipientUpdated(_feeRecipient);
    }

    /**
     * @notice Sets the required collateralization ratio in basis points.
     * @param _collateralRatio The new collateralization ratio within valid bounds.
     */
    function setCollateralRatio(uint256 _collateralRatio) external onlyOwner {
        if (
            _collateralRatio < MIN_COLLATERAL_RATIO ||
            _collateralRatio < liquidationThreshold ||
            _collateralRatio > MAX_COLLATERAL_RATIO
        ) revert InvalidParameter();
        _consumeTimelock(msg.sig, abi.encode(_collateralRatio));
        collateralRatio = _collateralRatio;
        emit CollateralRatioUpdated(_collateralRatio);
    }

    /**
     * @notice Sets the grace period before default can be declared
     * @param _gracePeriod The grace period in seconds (max 30 days)
     */
    function setGracePeriod(uint256 _gracePeriod) external onlyOwner {
        if (_gracePeriod > MAX_GRACE_PERIOD) revert InvalidParameter();
        _consumeTimelock(msg.sig, abi.encode(_gracePeriod));
        gracePeriod = _gracePeriod;
        emit GracePeriodUpdated(_gracePeriod);
    }

    /**
     * @notice Sets the liquidation threshold in basis points
     * @param _threshold The new liquidation threshold
     */
    function setLiquidationThreshold(uint256 _threshold) external onlyOwner {
        if (_threshold <= BASIS_POINTS + liquidationBonus || _threshold > collateralRatio) {
            revert InvalidParameter();
        }
        _consumeTimelock(msg.sig, abi.encode(_threshold));
        liquidationThreshold = _threshold;
        emit LiquidationThresholdUpdated(_threshold);
    }

    /**
     * @notice Gets the statistics of the contract
     * @return totalLoans Total number of loans
     * @return activeLoans Number of funded loans
     * @return repaidLoans Number of repaid loans
     * @return defaultedLoans Number of defaulted loans
     * @return cancelledLoans Number of cancelled loans
     * @return liquidatedLoans Number of liquidated loans
     */
    function getStats() external view returns (
        uint256 totalLoans,
        uint256 activeLoans,
        uint256 repaidLoans,
        uint256 defaultedLoans,
        uint256 cancelledLoans,
        uint256 liquidatedLoans
    ) {
        return (
            loanCount,
            activeLoansCount,
            repaidLoansCount,
            defaultedLoansCount,
            cancelledLoansCount,
            liquidatedLoansCount
        );
    }

    /**
     * @notice Calculates the credit score of a user in basis points (0-10000)
     * @param user The address of the user
     * @return score The calculated credit score
     */
    function getCreditScore(address user) external view returns (uint256 score) {
        UserReputation storage rep = userReputations[user];
        if (rep.totalLoans == 0) return 5000;

        uint256 repaymentRatio = Math.mulDiv(rep.repaidLoans, BASIS_POINTS, rep.totalLoans);
        uint256 volumeBonus = 0;
        if (rep.totalRepaidAmount > 100 ether) {
            volumeBonus = 1000;
        } else if (rep.totalRepaidAmount > 10 ether) {
            volumeBonus = 500;
        }

        score = repaymentRatio + volumeBonus;
        if (score > BASIS_POINTS) {
            score = BASIS_POINTS;
        }
    }

    /**
     * @notice Recovers unlocked ERC-20 tokens sent to the contract in an emergency.
     * @param token The address of the ERC-20 token to rescue.
     * @param amount The amount of tokens to transfer.
     * @param to The recipient address.
     */
    function rescueTokens(address token, uint256 amount, address to) external onlyOwner {
        if (token == address(0) || to == address(0)) revert InvalidAddress();
        uint256 contractBalance = IERC20(token).balanceOf(address(this));
        uint256 locked = lockedCollateral[token];
        if (contractBalance < locked + amount) revert InsufficientUnlockedCollateral();
        IERC20(token).safeTransfer(to, amount);
        emit TokensRescued(token, amount, to);
    }

    /**
     * @notice Creates a lender-initiated loan offer by escrowing ETH
     */
    function createLoanOffer(
        uint256 maxInterestRate,
        uint256 minDuration,
        uint256 maxDuration,
        address requiredCollateralToken,
        uint256 minCollateralRatio
    ) external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert InvalidAmount();
        if (msg.value > maxLoanAmount) revert LoanTooLarge();
        if (maxInterestRate == 0 || maxInterestRate > MAX_INTEREST_RATE) revert InvalidInterestRate();
        if (minDuration == 0 || maxDuration > MAX_LOAN_DURATION || minDuration > maxDuration) revert InvalidDuration();
        if (minCollateralRatio < MIN_COLLATERAL_RATIO || minCollateralRatio > MAX_COLLATERAL_RATIO) {
            revert InvalidParameter();
        }
        if (requiredCollateralToken != address(0) && !allowedCollateralTokens[requiredCollateralToken]) {
            revert TokenNotAllowed();
        }

        uint256 offerId = offerCount++;
        lockedETH += msg.value;
        loanOffers[offerId] = LoanOffer({
            lender: payable(msg.sender),
            principalAmount: msg.value,
            maxInterestRate: maxInterestRate,
            minDuration: minDuration,
            maxDuration: maxDuration,
            requiredCollateralToken: requiredCollateralToken,
            minCollateralRatio: minCollateralRatio,
            state: OfferState.Created,
            createdAt: block.timestamp,
            expiresAt: block.timestamp + 30 days
        });

        emit LoanOfferCreated(offerId, msg.sender, msg.value, maxInterestRate);
    }

    /**
     * @notice Cancels an open loan offer and refunds ETH to the lender
     */
    function cancelLoanOffer(uint256 offerId) external nonReentrant validOfferId(offerId) {
        LoanOffer storage offer = loanOffers[offerId];
        if (msg.sender != offer.lender) revert Unauthorized();
        if (offer.state != OfferState.Created) revert InvalidLoanState();

        offer.state = OfferState.Cancelled;
        lockedETH -= offer.principalAmount;
        offer.lender.sendValue(offer.principalAmount);
        emit LoanOfferCancelled(offerId);
    }

    /**
     * @notice Accepts an open loan offer by depositing collateral and creating a funded loan
     */
    function acceptLoanOffer(
        uint256 offerId,
        uint256 interestRate,
        uint256 duration,
        address collateralToken,
        uint256 collateralAmount
    ) external nonReentrant validOfferId(offerId) whenNotPaused {
        LoanOffer storage offer = loanOffers[offerId];
        if (offer.state != OfferState.Created) revert InvalidLoanState();
        if (block.timestamp > offer.expiresAt) revert OfferExpired();
        if (msg.sender == offer.lender) revert SelfFunding();
        if (borrowerActiveLoans[msg.sender] >= maxActiveLoansPerBorrower) revert TooManyActiveLoans();
        if (interestRate == 0 || interestRate > offer.maxInterestRate) revert InvalidInterestRate();
        if (duration < offer.minDuration || duration > offer.maxDuration) revert InvalidDuration();
        if (collateralAmount == 0) revert InvalidCollateral();
        if (collateralToken == address(0)) revert InvalidAddress();
        if (!allowedCollateralTokens[collateralToken]) revert TokenNotAllowed();
        if (offer.requiredCollateralToken != address(0) && collateralToken != offer.requiredCollateralToken) {
            revert TokenNotAllowed();
        }

        {
            uint256 collateralValueInETH = getCollateralValueInETH(collateralToken, collateralAmount);
            uint256 effectiveRatio = offer.minCollateralRatio > collateralRatio
                ? offer.minCollateralRatio
                : collateralRatio;
            uint256 requiredCollateralValueInETH = Math.mulDiv(offer.principalAmount, effectiveRatio, BASIS_POINTS);
            if (collateralValueInETH < requiredCollateralValueInETH) revert InsufficientCollateralValue();
        }

        IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), collateralAmount);
        lockedCollateral[collateralToken] += collateralAmount;

        offer.state = OfferState.Accepted;
        uint256 principal = offer.principalAmount;
        lockedETH -= principal;

        uint256 loanId = loanCount++;
        {
            uint256 annualInterest = Math.mulDiv(principal, interestRate, BASIS_POINTS);
            uint256 interestAmount = Math.mulDiv(annualInterest, duration, SECONDS_PER_YEAR);
            uint256 repaymentAmount = principal + interestAmount;

            loans[loanId] = Loan({
                borrower: payable(msg.sender),
                lender: offer.lender,
                principalAmount: principal,
                interestRate: uint16(interestRate),
                repaymentAmount: repaymentAmount,
                duration: duration,
                startTime: block.timestamp,
                state: LoanState.Funded,
                collateralToken: collateralToken,
                collateralAmount: collateralAmount,
                remainingRepaymentAmount: repaymentAmount
            });
        }

        borrowerActiveLoans[msg.sender]++;
        lenderActiveLoans[offer.lender]++;
        activeLoansCount++;
        _borrowerLoanIds[msg.sender].push(loanId);
        _lenderLoanIds[offer.lender].push(loanId);

        uint256 feeAmount = principal * platformFee / BASIS_POINTS;
        uint256 amountToBorrower = principal - feeAmount;
        payable(feeRecipient).sendValue(feeAmount);
        payable(msg.sender).sendValue(amountToBorrower);

        emit LoanOfferAccepted(offerId, loanId, msg.sender);
    }

    /**
     * @notice Expires a past-due loan offer and refunds ETH to the lender
     */
    function expireLoanOffer(uint256 offerId) external nonReentrant validOfferId(offerId) {
        LoanOffer storage offer = loanOffers[offerId];
        if (offer.state != OfferState.Created) revert InvalidLoanState();
        if (block.timestamp <= offer.expiresAt) revert OfferNotExpired();

        offer.state = OfferState.Expired;
        lockedETH -= offer.principalAmount;
        offer.lender.sendValue(offer.principalAmount);
        emit LoanOfferExpired(offerId);
    }

    /**
     * @notice Recovers unlocked ETH from the contract in an emergency.
     * @param amount The amount of ETH in wei to transfer.
     * @param to The recipient address.
     */
    function rescueETH(uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        if (address(this).balance < lockedETH || amount > address(this).balance - lockedETH) {
            revert InsufficientUnlockedETH();
        }
        payable(to).sendValue(amount);
        emit ETHRescued(amount, to);
    }
}
