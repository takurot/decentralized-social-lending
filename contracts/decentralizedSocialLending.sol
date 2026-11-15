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

    // ローンオファーの状態を表す列挙型
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

    // タイムロック設定
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

    // ローンオファー関連のストレージ
    mapping(uint256 => LoanOffer) public loanOffers;
    uint256 public offerCount;

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

    // 信用スコア・レピュテーション構造体
    struct UserReputation {
        uint256 totalLoans;
        uint256 repaidLoans;
        uint256 defaultedLoans;
        uint256 totalBorrowedAmount;
        uint256 totalRepaidAmount;
        uint256 lastActivityTimestamp;
    }

    mapping(address => UserReputation) public userReputations;

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

    // 修飾子: 有効なオファーIDかチェック
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

        UserReputation storage rep = userReputations[loan.borrower];
        rep.totalLoans++;
        rep.totalBorrowedAmount += loan.principalAmount;
        rep.lastActivityTimestamp = block.timestamp;
        emit ReputationUpdated(loan.borrower, rep.totalLoans, rep.repaidLoans, rep.defaultedLoans);

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
        UserReputation storage rep = userReputations[loan.borrower];
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

            rep.repaidLoans++;
            rep.totalRepaidAmount += amount;
            rep.lastActivityTimestamp = block.timestamp;
            emit ReputationUpdated(loan.borrower, rep.totalLoans, rep.repaidLoans, rep.defaultedLoans);

            // 担保の返却
            lockedCollateral[loan.collateralToken] -= loan.collateralAmount;
            IERC20(loan.collateralToken).safeTransfer(loan.borrower, loan.collateralAmount);

            emit LoanRepaid(loanId, loan.borrower, loan.lender, amount);
        } else {
            // 部分返済
            loan.remainingRepaymentAmount -= amount;

            rep.totalRepaidAmount += amount;
            rep.lastActivityTimestamp = block.timestamp;
            emit ReputationUpdated(loan.borrower, rep.totalLoans, rep.repaidLoans, rep.defaultedLoans);

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

        UserReputation storage rep = userReputations[loan.borrower];
        rep.defaultedLoans++;
        rep.lastActivityTimestamp = block.timestamp;
        emit ReputationUpdated(loan.borrower, rep.totalLoans, rep.repaidLoans, rep.defaultedLoans);

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

        UserReputation storage rep = userReputations[loan.borrower];
        rep.defaultedLoans++;
        rep.lastActivityTimestamp = block.timestamp;
        emit ReputationUpdated(loan.borrower, rep.totalLoans, rep.repaidLoans, rep.defaultedLoans);

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

    // プラットフォーム手数料を設定する関数（管理者用）
    function setPlatformFee(uint256 _platformFee) external onlyOwner {
        if (_platformFee > MAX_PLATFORM_FEE) revert InvalidParameter();
        _consumeTimelock(msg.sig, abi.encode(_platformFee));
        platformFee = _platformFee;
        emit PlatformFeeUpdated(_platformFee);
    }

    // 手数料受取者を設定する関数（管理者用）
    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        if (_feeRecipient == address(0)) revert InvalidAddress();
        _consumeTimelock(msg.sig, abi.encode(_feeRecipient));
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

    // 緊急時にトークンを回収する関数（管理者用）
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

    // 緊急時にETHを回収する関数（管理者用）
    function rescueETH(uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        if (address(this).balance < lockedETH || amount > address(this).balance - lockedETH) {
            revert InsufficientUnlockedETH();
        }
        payable(to).sendValue(amount);
        emit ETHRescued(amount, to);
    }
}
