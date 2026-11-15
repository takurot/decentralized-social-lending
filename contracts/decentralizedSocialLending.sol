// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// OpenZeppelinのライブラリをインポート
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

// Chainlinkのオラクルインターフェースをインポート
import "./interfaces/AggregatorV3Interface.sol";

// カスタムエラー定義
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
error CollateralSufficient();
error NoDebtToLiquidate();
error InsufficientUnlockedETH();
error TokenDecimalsNotSet();

contract SocialLendingWithCollateral is ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;
    using Address for address payable;

    // 定数
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant MAX_INTEREST_RATE = 2000; // 20%
    uint256 public constant MAX_PLATFORM_FEE = 500;  // 5%
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant PRICE_FEED_TIMEOUT = 1 hours; // 価格フィードの有効期限
    uint256 public constant MAX_LOAN_DURATION = 365 days; // ローン期間の上限
    uint256 public constant MAX_GRACE_PERIOD = 30 days; // 猶予期間の上限

    // ローンの状態を表す列挙型
    enum LoanState { Requested, Funded, Repaid, Defaulted, Cancelled, Liquidated }

    // ローンの構造体
    struct Loan {
        // Slot 1: borrower (20) + state (1) + interestRate (2) = 23 bytes
        address payable borrower;
        LoanState state;         // ローンの状態 (1 byte)
        uint16 interestRate;     // 利率 (2 bytes)
        
        // Slot 2: lender (20)
        address payable lender;

        // Slot 3
        address collateralToken; // 担保トークンのアドレス

        // Slot 4
        uint256 principalAmount; // 元本

        // Slot 5
        uint256 repaymentAmount; // 返済総額

        // Slot 6
        uint256 duration;        // 期間（秒）

        // Slot 7
        uint256 startTime;       // 開始時刻

        // Slot 8
        uint256 collateralAmount;// 担保数量

        // Slot 9
        uint256 remainingRepaymentAmount; // 残りの返済額
    }

    // ローンIDからローン情報へのマッピング
    mapping(uint256 => Loan) public loans;
    uint256 public loanCount;

    // ユーザー別ローンIDインデックス (Gas Optimization)
    mapping(address => uint256[]) private _borrowerLoanIds;
    mapping(address => uint256[]) private _lenderLoanIds;

    // 統計カウンタ (Gas Optimization)
    uint256 public activeLoansCount;
    uint256 public repaidLoansCount;
    uint256 public defaultedLoansCount;
    uint256 public cancelledLoansCount;
    uint256 public liquidatedLoansCount;

    // ユーザーのアクティブローン数追跡
    mapping(address => uint256) public borrowerActiveLoans;
    mapping(address => uint256) public lenderActiveLoans;

    // 許可された担保トークンリスト
    mapping(address => bool) public allowedCollateralTokens;
    
    // 担保トークンのデシマル
    mapping(address => uint8) public collateralTokenDecimals;
    mapping(address => bool) public collateralDecimalsSet;

    // オラクルのマッピング（担保トークンアドレス => プライスフィードアドレス）
    mapping(address => address) public priceFeeds;

    // プラットフォーム手数料（ベーシスポイント）
    uint256 public platformFee = 100; // 1%
    address public feeRecipient;

    // 担保トークンごとのロック済み残高
    mapping(address => uint256) public lockedCollateral;

    // 保留中のETH引き出し残高（Pull-paymentフォールバック）とロック済みETH
    mapping(address => uint256) public pendingETHWithdrawals;
    uint256 public lockedETH;

    // 借入制限
    uint256 public maxLoanAmount = 10 ether;
    uint256 public maxActiveLoansPerBorrower = 3;

    // 担保率（Collateral Ratio）（例: 15000で150%）
    // 旧: ltvRatio
    uint256 public collateralRatio = 15000;
    uint256 public constant MIN_COLLATERAL_RATIO = 10000; // 100%
    uint256 public constant MAX_COLLATERAL_RATIO = 20000; // 200%

    // 猶予期間と清算パラメータ
    uint256 public gracePeriod = 3 days;
    uint256 public liquidationThreshold = 12000; // 120%
    uint256 public liquidationBonus = 500;       // 5%

    // イベントの定義
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

    ///// コントラクト動作説明用のコメント追加 /////
    /*
    コントラクトの主要な動作フロー:
    
    1. ローンリクエスト
    - 借り手が担保トークンと条件を指定してリクエスト
    - 担保価値がLTV比率を満たすことを検証
    - 担保トークンをコントラクトに預託
    
    2. ローン資金提供
    - 貸し手がETHでローンを資金化
    - プラットフォーム手数料を控除
    - 残金を借り手に送金
    
    3. 返済プロセス
    - 借り手が部分返済/全額返済可能
    - 全額返済時: 担保を返却
    - 返済期限超過時: 担保没収
    
    4. デフォルト処理
    - 自動検出（誰でも実行可能）or 貸し手が手動実行
    - 担保を貸し手に移転
    
    主要なセキュリティ機能:
    - リエントランシー攻撃防止（ReentrancyGuard）
    - 緊急停止機能（Pausable）
    - 価格フィード検証（Chainlink Oracle）
    - 入力パラメータ検証
    - アクセス制御（Ownable）
    */

    // 修飾子: 借り手のみ
    modifier onlyBorrower(uint256 loanId) {
        if (msg.sender != loans[loanId].borrower) revert Unauthorized();
        _;
    }

    // 修飾子: 貸し手のみ
    modifier onlyLender(uint256 loanId) {
        if (msg.sender != loans[loanId].lender) revert Unauthorized();
        _;
    }

    // 修飾子: 有効なローンIDかチェック
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

        // 担保のデポジットと実受取額の計測（Fee-on-Transferトークン対策）
        uint256 balanceBefore = IERC20(collateralToken).balanceOf(address(this));
        IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), collateralAmount);
        uint256 actualCollateral = IERC20(collateralToken).balanceOf(address(this)) - balanceBefore;
        if (actualCollateral == 0) revert InvalidCollateral();

        // 単利による返済総額の計算（Math.mulDivを使用）
        uint256 annualInterest = Math.mulDiv(amount, interestRate, BASIS_POINTS);
        uint256 interestAmount = Math.mulDiv(annualInterest, duration, SECONDS_PER_YEAR);
        uint256 repaymentAmount = amount + interestAmount;

        // 担保価値の評価（実受取額と返済総額を基準に必要担保価値を計算）
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

        // 状態変更を先に行う（再入攻撃対策）
        loan.state = LoanState.Cancelled;
        borrowerActiveLoans[loan.borrower]--;
        cancelledLoansCount++;

        // 担保の返却
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

        // 状態変更を先に行う（再入攻撃対策）
        loan.lender = payable(msg.sender);
        loan.startTime = block.timestamp;
        loan.state = LoanState.Funded;
        lenderActiveLoans[msg.sender]++;
        
        activeLoansCount++;
        _lenderLoanIds[msg.sender].push(loanId);

        // プラットフォーム手数料の計算と送金
        uint256 feeAmount = msg.value * platformFee / BASIS_POINTS;
        uint256 amountToBorrower = msg.value - feeAmount;

        // 手数料送金（失敗時はPull-paymentキューへ退避）
        _safeTransferETHOrQueue(feeRecipient, feeAmount);

        // 借り手への送金（失敗時はPull-paymentキューへ退避）
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

        // 状態変更を先に行う（再入攻撃対策）
        if (amount >= loan.remainingRepaymentAmount) {
            // 全額返済
            excessAmount = amount - loan.remainingRepaymentAmount;
            amount = loan.remainingRepaymentAmount;
            loan.remainingRepaymentAmount = 0;
            loan.state = LoanState.Repaid;
            borrowerActiveLoans[loan.borrower]--;
            lenderActiveLoans[loan.lender]--;
            
            activeLoansCount--;
            repaidLoansCount++;

            // 担保の返却
            lockedCollateral[loan.collateralToken] -= loan.collateralAmount;
            IERC20(loan.collateralToken).safeTransfer(loan.borrower, loan.collateralAmount);

            emit LoanRepaid(loanId, loan.borrower, loan.lender, amount);
        } else {
            // 部分返済
            loan.remainingRepaymentAmount -= amount;
            emit LoanPartiallyRepaid(loanId, loan.borrower, amount, loan.remainingRepaymentAmount);
        }

        // 貸し手への送金（失敗時はPull-paymentキューへ退避）
        _safeTransferETHOrQueue(loan.lender, amount);

        // 余剰分を借り手に返却（失敗時はPull-paymentキューへ退避）
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
        if (loan.remainingRepaymentAmount == 0) revert LoanAlreadyRepaid();

        // 状態変更を先に行う（再入攻撃対策）
        loan.state = LoanState.Defaulted;
        borrowerActiveLoans[loan.borrower]--;
        lenderActiveLoans[loan.lender]--;
        
        activeLoansCount--;
        defaultedLoansCount++;

        // 担保の貸し手への移転
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
        if (loan.remainingRepaymentAmount == 0) revert LoanAlreadyRepaid();

        // 状態変更を先に行う（再入攻撃対策）
        loan.state = LoanState.Defaulted;
        borrowerActiveLoans[loan.borrower]--;
        lenderActiveLoans[loan.lender]--;

        activeLoansCount--;
        defaultedLoansCount++;

        // 担保の貸し手への移転
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

        // 状態変更を先に行う（再入攻撃対策）
        loan.remainingRepaymentAmount = 0;
        loan.state = LoanState.Liquidated;
        borrowerActiveLoans[loan.borrower]--;
        lenderActiveLoans[loan.lender]--;
        activeLoansCount--;
        liquidatedLoansCount++;
        lockedCollateral[loan.collateralToken] -= loan.collateralAmount;

        // ETH・担保の移転
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
        
        // 価格データの取得と検証
        (
            uint80 roundId,
            int256 price,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = priceFeed.latestRoundData();

        // 価格データの検証
        if (price <= 0) revert InvalidPriceData();
        if (startedAt == 0 || updatedAt == 0 || updatedAt < startedAt || updatedAt > block.timestamp) {
            revert InvalidPriceData();
        }
        if (block.timestamp - updatedAt > PRICE_FEED_TIMEOUT) revert StaleData();
        if (answeredInRound < roundId) revert StaleData();

        if (!collateralDecimalsSet[collateralToken]) revert TokenDecimalsNotSet();

        uint8 decimals = priceFeed.decimals();
        uint8 tokenDecimals = collateralTokenDecimals[collateralToken];

        // 担保トークンのデシマルを考慮した計算（Math.mulDivを使用）
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
        
        // ファーストパス: カウント
        for (uint256 i = 0; i < allLoanIds.length; i++) {
            LoanState state = loans[allLoanIds[i]].state;
            if (state == LoanState.Requested || state == LoanState.Funded) {
                activeCount++;
            }
        }
        
        uint256[] memory activeLoanIds = new uint256[](activeCount);
        uint256 counter = 0;
        
        // セカンドパス: 充填
        for (uint256 i = 0; i < allLoanIds.length; i++) {
            LoanState state = loans[allLoanIds[i]].state;
            if (state == LoanState.Requested || state == LoanState.Funded) {
                activeLoanIds[counter] = allLoanIds[i];
                counter++;
            }
        }
        
        return activeLoanIds;
    }

    // 現在の担保率(BASIS_POINTS=10000)を取得する関数
    function getCollateralizationRatio(uint256 loanId) external view validLoanId(loanId) returns (uint256) {
        Loan storage loan = loans[loanId];
        if (loan.state != LoanState.Funded) revert InvalidLoanState();

        uint256 collateralValue = getCollateralValueInETH(loan.collateralToken, loan.collateralAmount);
        if (loan.remainingRepaymentAmount == 0) {
            return type(uint256).max;
        }
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
        
        // ファーストパス: カウント
        for (uint256 i = 0; i < allLoanIds.length; i++) {
            if (loans[allLoanIds[i]].state == LoanState.Funded) {
                activeCount++;
            }
        }
        
        uint256[] memory activeLoanIds = new uint256[](activeCount);
        uint256 counter = 0;
        
        // セカンドパス: 充填
        for (uint256 i = 0; i < allLoanIds.length; i++) {
            if (loans[allLoanIds[i]].state == LoanState.Funded) {
                activeLoanIds[counter] = allLoanIds[i];
                counter++;
            }
        }
        
        return activeLoanIds;
    }

    // プラットフォーム手数料を設定する関数（管理者用）
    function setPlatformFee(uint256 _platformFee) external onlyOwner {
        if (_platformFee > MAX_PLATFORM_FEE) revert InvalidParameter();
        platformFee = _platformFee;
        emit PlatformFeeUpdated(_platformFee);
    }

    // 手数料受取者を設定する関数（管理者用）
    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        if (_feeRecipient == address(0)) revert InvalidAddress();
        feeRecipient = _feeRecipient;
        emit FeeRecipientUpdated(_feeRecipient);
    }

    // 担保率（Collateral Ratio）を設定する関数（管理者用）
    function setCollateralRatio(uint256 _collateralRatio) external onlyOwner {
        if (
            _collateralRatio < MIN_COLLATERAL_RATIO ||
            _collateralRatio < liquidationThreshold ||
            _collateralRatio > MAX_COLLATERAL_RATIO
        ) revert InvalidParameter();
        collateralRatio = _collateralRatio;
        emit CollateralRatioUpdated(_collateralRatio);
    }

    /**
     * @notice Sets the grace period before default can be declared
     * @param _gracePeriod The grace period in seconds (max 30 days)
     */
    function setGracePeriod(uint256 _gracePeriod) external onlyOwner {
        if (_gracePeriod > MAX_GRACE_PERIOD) revert InvalidParameter();
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

    // 緊急時にトークンを回収する関数（管理者用）
    function rescueTokens(address token, uint256 amount, address to) external onlyOwner {
        if (token == address(0) || to == address(0)) revert InvalidAddress();
        uint256 contractBalance = IERC20(token).balanceOf(address(this));
        uint256 locked = lockedCollateral[token];
        if (contractBalance < locked + amount) revert InsufficientUnlockedCollateral();
        IERC20(token).safeTransfer(to, amount);
        emit TokensRescued(token, amount, to);
    }

    // 緊急時にETHを回収する関数（管理者用）
    function rescueETH(uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        if (address(this).balance < lockedETH + amount) revert InsufficientUnlockedETH();
        payable(to).sendValue(amount);
        emit ETHRescued(amount, to);
    }
}
