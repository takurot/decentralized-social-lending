// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Import OpenZeppelin libraries
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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

    // Loan lifecycle states
    enum LoanState { Requested, Funded, Repaid, Defaulted, Cancelled }

    // Loan data structure
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

    // Mapping from loan ID to Loan struct
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

    // Active loan count per user
    mapping(address => uint256) public borrowerActiveLoans;
    mapping(address => uint256) public lenderActiveLoans;

    // Allowed collateral token registry
    mapping(address => bool) public allowedCollateralTokens;
    
    // Collateral token decimals
    mapping(address => uint8) public collateralTokenDecimals;

    // Oracle mapping (collateral token => price feed)
    mapping(address => address) public priceFeeds;

    // Platform fee in basis points
    uint256 public platformFee = 100; // 1%
    address public feeRecipient;

    // Locked collateral balance per token
    mapping(address => uint256) public lockedCollateral;

    // Borrowing limits
    uint256 public maxLoanAmount = 10 ether;
    uint256 public maxActiveLoansPerBorrower = 3;

    // Collateral ratio in basis points (e.g. 15000 = 150%)
    // Legacy: ltvRatio
    uint256 public collateralRatio = 15000;
    uint256 public constant MIN_COLLATERAL_RATIO = 10000; // 100%
    uint256 public constant MAX_COLLATERAL_RATIO = 20000; // 200%

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

    /**
     * @notice Constructor to initialize the contract with the fee recipient
     * @param _feeRecipient The address to receive platform fees
     */
    /**
     * @notice Deploys the lending contract with an initial fee recipient.
     * @param _feeRecipient The address that receives platform fees.
     */
    constructor(address _feeRecipient) {
        if (_feeRecipient == address(0)) revert InvalidAddress();
        feeRecipient = _feeRecipient;
        _transferOwnership(msg.sender);
    }

    /**
     * @notice Sets the maximum number of active loans allowed per borrower.
     * @param _max The new maximum active loans per borrower (must be > 0).
     */
    function setMaxActiveLoansPerBorrower(uint256 _max) external onlyOwner {
        if (_max == 0) revert InvalidParameter();
        maxActiveLoansPerBorrower = _max;
        emit MaxActiveLoansPerBorrowerUpdated(_max);
    }

    /**
     * @notice Sets the maximum principal amount allowed for a single loan.
     * @param _maxLoanAmount The new maximum loan amount in wei (must be > 0).
     */
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

    4. Default Handling
    - Triggered by lender (declareDefault) or anyone (checkAndDeclareDefault) after expiration.
    - Escrowed collateral is transferred to lender.

    Security Controls:
    - ReentrancyGuard on state-changing external functions
    - Pausable emergency stop (owner only)
    - Chainlink oracle staleness and sanity checks
    - Strict input bounds and Ownable access control
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
        allowedCollateralTokens[token] = allowed;
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
        collateralTokenDecimals[token] = decimals;
        emit CollateralTokenDecimalsUpdated(token, decimals);
    }

    /**
     * @notice Sets the price feed for a collateral token
     * @param token The address of the collateral token
     * @param priceFeed The address of the price feed contract
     */
    function setPriceFeed(address token, address priceFeed) external onlyOwner {
        if (token == address(0) || priceFeed == address(0)) revert InvalidAddress();
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

        // Evaluate collateral value
        uint256 collateralValueInETH = getCollateralValueInETH(collateralToken, collateralAmount);
        
        // collateralRatio = 15000 requires 150% collateral value relative to loan amount
        uint256 requiredCollateralValueInETH = amount * collateralRatio / BASIS_POINTS;
        if (collateralValueInETH < requiredCollateralValueInETH) revert InsufficientCollateralValue();

        // Deposit collateral
        IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), collateralAmount);
        lockedCollateral[collateralToken] += collateralAmount;

        uint256 loanId = loanCount++;

        // Calculate total repayment with simple interest using Math.mulDiv
        uint256 annualInterest = Math.mulDiv(amount, interestRate, BASIS_POINTS);
        uint256 interestAmount = Math.mulDiv(annualInterest, duration, SECONDS_PER_YEAR);
        uint256 repaymentAmount = amount + interestAmount;

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
            collateralAmount: collateralAmount,
            remainingRepaymentAmount: repaymentAmount
        });

        borrowerActiveLoans[msg.sender]++;
        _borrowerLoanIds[msg.sender].push(loanId);

        emit LoanRequested(loanId, msg.sender, amount, interestRate, duration, collateralToken, collateralAmount);
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

        // Calculate and transfer platform fee
        uint256 feeAmount = msg.value * platformFee / BASIS_POINTS;
        uint256 amountToBorrower = msg.value - feeAmount;

        // Transfer fee to recipient
        payable(feeRecipient).sendValue(feeAmount);

        // Transfer principal minus fee to borrower
        loan.borrower.sendValue(amountToBorrower);

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

            // Return collateral
            lockedCollateral[loan.collateralToken] -= loan.collateralAmount;
            IERC20(loan.collateralToken).safeTransfer(loan.borrower, loan.collateralAmount);

            emit LoanRepaid(loanId, loan.borrower, loan.lender, amount);
        } else {
            // Partial repayment
            loan.remainingRepaymentAmount -= amount;
            emit LoanPartiallyRepaid(loanId, loan.borrower, amount, loan.remainingRepaymentAmount);
        }

        // Transfer repayment to lender
        loan.lender.sendValue(amount);

        // Refund excess payment to borrower
        if (excessAmount > 0) {
            loan.borrower.sendValue(excessAmount);
        }
    }

    /**
     * @notice Allows the lender to declare default and claim collateral if the loan is overdue
     * @param loanId The ID of the loan to declare default
     */
    function declareDefault(uint256 loanId) external nonReentrant validLoanId(loanId) onlyLender(loanId) whenNotPaused {
        Loan storage loan = loans[loanId];
        if (loan.state != LoanState.Funded) revert InvalidLoanState();
        if (block.timestamp <= loan.startTime + loan.duration) revert LoanNotExpired();
        if (loan.remainingRepaymentAmount == 0) revert LoanAlreadyRepaid();

        // Update state before external calls (Checks-Effects-Interactions)
        loan.state = LoanState.Defaulted;
        borrowerActiveLoans[loan.borrower]--;
        lenderActiveLoans[loan.lender]--;
        
        activeLoansCount--;
        defaultedLoansCount++;
        liquidatedLoansCount++;

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
        if (block.timestamp <= loan.startTime + loan.duration) revert LoanNotExpired();
        if (loan.remainingRepaymentAmount == 0) revert LoanAlreadyRepaid();

        // Update state before external calls (Checks-Effects-Interactions)
        loan.state = LoanState.Defaulted;
        borrowerActiveLoans[loan.borrower]--;
        lenderActiveLoans[loan.lender]--;

        activeLoansCount--;
        defaultedLoansCount++;
        liquidatedLoansCount++;

        // Transfer collateral to lender
        lockedCollateral[loan.collateralToken] -= loan.collateralAmount;
        IERC20(loan.collateralToken).safeTransfer(loan.lender, loan.collateralAmount);

        emit DefaultDeclared(loanId, loan.lender);
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
        if (startedAt == 0 || updatedAt == 0 || updatedAt < startedAt) revert InvalidPriceData();
        if (updatedAt < block.timestamp - PRICE_FEED_TIMEOUT) revert StaleData();
        if (answeredInRound < roundId) revert StaleData();

        uint8 decimals = priceFeed.decimals();
        
        // Normalize collateral amount using token decimals
        uint8 tokenDecimals = collateralTokenDecimals[collateralToken];
        uint256 normalizedAmount = collateralAmount;
        if (tokenDecimals > 0) {
            normalizedAmount = collateralAmount * 10**18 / 10**uint256(tokenDecimals);
        }

        uint256 collateralValueInETH = normalizedAmount * uint256(price) / 10**uint256(decimals);
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
        if (loan.remainingRepaymentAmount == 0) {
            return type(uint256).max;
        }
        return collateralValue * BASIS_POINTS / loan.remainingRepaymentAmount;
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
     * @notice Sets the platform fee in basis points.
     * @param _platformFee The new platform fee (must be <= MAX_PLATFORM_FEE).
     */
    function setPlatformFee(uint256 _platformFee) external onlyOwner {
        if (_platformFee > MAX_PLATFORM_FEE) revert InvalidParameter();
        platformFee = _platformFee;
        emit PlatformFeeUpdated(_platformFee);
    }

    /**
     * @notice Sets the platform fee recipient address.
     * @param _feeRecipient The new non-zero fee recipient address.
     */
    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        if (_feeRecipient == address(0)) revert InvalidAddress();
        feeRecipient = _feeRecipient;
        emit FeeRecipientUpdated(_feeRecipient);
    }

    /**
     * @notice Sets the required collateralization ratio in basis points.
     * @param _collateralRatio The new collateralization ratio within [MIN_COLLATERAL_RATIO, MAX_COLLATERAL_RATIO].
     */
    function setCollateralRatio(uint256 _collateralRatio) external onlyOwner {
        if (_collateralRatio < MIN_COLLATERAL_RATIO || _collateralRatio > MAX_COLLATERAL_RATIO) revert InvalidParameter();
        collateralRatio = _collateralRatio;
        emit CollateralRatioUpdated(_collateralRatio);
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
    }

    /**
     * @notice Recovers ETH from the contract in an emergency.
     * @param amount The amount of ETH in wei to transfer.
     * @param to The recipient address.
     */
    function rescueETH(uint256 amount, address to) external onlyOwner {
        if (to == address(0)) revert InvalidAddress();
        payable(to).sendValue(amount);
    }
}
