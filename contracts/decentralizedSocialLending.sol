// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// OpenZeppelinのライブラリをインポート
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

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
error TransferFailed();
error InvalidAddress();
error InvalidLoanId();
error InvalidParameter();
error Unauthorized();

contract SocialLendingWithCollateral is ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;

    // 定数
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant MAX_INTEREST_RATE = 2000; // 20%
    uint256 public constant MAX_PLATFORM_FEE = 500;  // 5%
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant PRICE_FEED_TIMEOUT = 1 hours; // 価格フィードの有効期限

    // ローンの状態を表す列挙型
    enum LoanState { Requested, Funded, Repaid, Defaulted, Cancelled }

    // ローンの構造体
    struct Loan {
        address payable borrower;
        address payable lender;
        uint256 principalAmount; // 元本
        uint256 interestRate;    // 利率（ベーシスポイント、例: 500で5%）
        uint256 repaymentAmount; // 返済総額
        uint256 duration;        // 期間（秒）
        uint256 startTime;       // 開始時刻
        LoanState state;         // ローンの状態
        address collateralToken; // 担保トークンのアドレス
        uint256 collateralAmount;// 担保数量
        uint256 remainingRepaymentAmount; // 残りの返済額
    }

    // ローンIDからローン情報へのマッピング
    mapping(uint256 => Loan) public loans;
    uint256 public loanCount;

    // ユーザーのアクティブローン数追跡
    mapping(address => uint256) public borrowerActiveLoans;
    mapping(address => uint256) public lenderActiveLoans;

    // 許可された担保トークンリスト
    mapping(address => bool) public allowedCollateralTokens;
    
    // 担保トークンのデシマル
    mapping(address => uint8) public collateralTokenDecimals;

    // オラクルのマッピング（担保トークンアドレス => プライスフィードアドレス）
    mapping(address => address) public priceFeeds;

    // プラットフォーム手数料（ベーシスポイント）
    uint256 public platformFee = 100; // 1%
    address public feeRecipient;

    // ローン・トゥ・バリュー（LTV）比率（例: 5000で50%）
    uint256 public ltvRatio = 5000;

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
    event LTVRatioUpdated(uint256 newRatio);
    event CollateralTokenStatusUpdated(address indexed token, bool allowed);
    event CollateralTokenDecimalsUpdated(address indexed token, uint8 decimals);

    /**
     * @notice Constructor to initialize the contract with the fee recipient
     * @param _feeRecipient The address to receive platform fees
     */
    constructor(address _feeRecipient) {
        if (_feeRecipient == address(0)) revert InvalidAddress();
        feeRecipient = _feeRecipient;
        _transferOwnership(msg.sender);
    }

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
        emit CollateralTokenStatusUpdated(token, allowed);
    }

    /**
     * @notice Sets the decimal places for a collateral token
     * @param token The address of the collateral token
     * @param decimals The number of decimal places for the token
     */
    function setCollateralTokenDecimals(address token, uint8 decimals) external onlyOwner {
        if (token == address(0)) revert InvalidAddress();
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
        if (duration == 0) revert InvalidDuration();
        if (collateralAmount == 0) revert InvalidCollateral();
        if (!allowedCollateralTokens[collateralToken]) revert TokenNotAllowed();

        // 担保価値の評価
        uint256 collateralValueInETH = getCollateralValueInETH(collateralToken, collateralAmount);
        uint256 requiredCollateralValueInETH = amount * ltvRatio / BASIS_POINTS;
        if (collateralValueInETH < requiredCollateralValueInETH) revert InsufficientCollateralValue();

        // 担保のデポジット
        IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), collateralAmount);

        uint256 loanId = loanCount++;

        // 単利による返済総額の計算（オーバーフロー防止のため計算順序を変更）
        uint256 interestAmount = amount * interestRate * duration / SECONDS_PER_YEAR / BASIS_POINTS;
        uint256 repaymentAmount = amount + interestAmount;

        loans[loanId] = Loan({
            borrower: payable(msg.sender),
            lender: payable(address(0)),
            principalAmount: amount,
            interestRate: interestRate,
            repaymentAmount: repaymentAmount,
            duration: duration,
            startTime: 0,
            state: LoanState.Requested,
            collateralToken: collateralToken,
            collateralAmount: collateralAmount,
            remainingRepaymentAmount: repaymentAmount
        });

        borrowerActiveLoans[msg.sender]++;

        emit LoanRequested(loanId, msg.sender, amount, interestRate, duration, collateralToken, collateralAmount);
    }

    /**
     * @notice Allows the borrower to cancel a loan request before it is funded
     * @param loanId The ID of the loan to cancel
     */
    function cancelLoanRequest(uint256 loanId) external nonReentrant onlyBorrower(loanId) validLoanId(loanId) whenNotPaused {
        Loan storage loan = loans[loanId];
        if (loan.state != LoanState.Requested) revert InvalidLoanState();

        // 状態変更を先に行う（再入攻撃対策）
        loan.state = LoanState.Cancelled;
        borrowerActiveLoans[loan.borrower]--;

        // 担保の返却
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

        // プラットフォーム手数料の計算と送金
        uint256 feeAmount = msg.value * platformFee / BASIS_POINTS;
        uint256 amountToBorrower = msg.value - feeAmount;

        // 手数料送金
        (bool feeSuccess, ) = feeRecipient.call{value: feeAmount}("");
        if (!feeSuccess) revert TransferFailed();

        // 借り手への送金
        (bool success, ) = loan.borrower.call{value: amountToBorrower}("");
        if (!success) revert TransferFailed();

        emit LoanFunded(loanId, msg.sender);
    }

    /**
     * @notice Allows the borrower to repay the loan, supporting partial repayments
     * @param loanId The ID of the loan to repay
     */
    function repayLoan(uint256 loanId) external payable nonReentrant onlyBorrower(loanId) validLoanId(loanId) whenNotPaused {
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

            // 担保の返却
            IERC20(loan.collateralToken).safeTransfer(loan.borrower, loan.collateralAmount);

            emit LoanRepaid(loanId, loan.borrower, loan.lender, amount);
        } else {
            // 部分返済
            loan.remainingRepaymentAmount -= amount;
            emit LoanPartiallyRepaid(loanId, loan.borrower, amount, loan.remainingRepaymentAmount);
        }

        // 貸し手への送金
        (bool success, ) = loan.lender.call{value: amount}("");
        if (!success) revert TransferFailed();

        // 余剰分を借り手に返却
        if (excessAmount > 0) {
            (bool excessSuccess, ) = loan.borrower.call{value: excessAmount}("");
            if (!excessSuccess) revert TransferFailed();
        }
    }

    /**
     * @notice Allows the lender to declare default and claim collateral if the loan is overdue
     * @param loanId The ID of the loan to declare default
     */
    function declareDefault(uint256 loanId) external nonReentrant onlyLender(loanId) validLoanId(loanId) whenNotPaused {
        Loan storage loan = loans[loanId];
        if (loan.state != LoanState.Funded) revert InvalidLoanState();
        if (block.timestamp <= loan.startTime + loan.duration) revert LoanNotExpired();
        if (loan.remainingRepaymentAmount == 0) revert LoanAlreadyRepaid();

        // 状態変更を先に行う（再入攻撃対策）
        loan.state = LoanState.Defaulted;
        borrowerActiveLoans[loan.borrower]--;
        lenderActiveLoans[loan.lender]--;

        // 担保の貸し手への移転
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

        // 状態変更を先に行う（再入攻撃対策）
        loan.state = LoanState.Defaulted;
        borrowerActiveLoans[loan.borrower]--;
        lenderActiveLoans[loan.lender]--;

        // 担保の貸し手への移転
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
        if (updatedAt < block.timestamp - PRICE_FEED_TIMEOUT) revert StaleData();
        if (answeredInRound < roundId) revert StaleData();

        uint8 decimals = priceFeed.decimals();
        
        // 担保トークンのデシマルを考慮した計算
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
        // 実際のアクティブローン数をカウント
        uint256 activeCount = 0;
        for (uint256 i = 0; i < loanCount; i++) {
            if (loans[i].borrower == borrower && 
                (loans[i].state == LoanState.Requested || loans[i].state == LoanState.Funded)) {
                activeCount++;
            }
        }
        
        // 正確なサイズの配列を作成
        uint256[] memory borrowerLoans = new uint256[](activeCount);
        uint256 counter = 0;
        
        for (uint256 i = 0; i < loanCount && counter < activeCount; i++) {
            if (loans[i].borrower == borrower && 
                (loans[i].state == LoanState.Requested || loans[i].state == LoanState.Funded)) {
                borrowerLoans[counter] = i;
                counter++;
            }
        }
        
        return borrowerLoans;
    }

    /**
     * @notice Gets the list of funded loan IDs for a lender
     * @param lender The address of the lender
     * @return Array of loan IDs
     */
    function getLenderLoans(address lender) external view returns (uint256[] memory) {
        // 実際のアクティブローン数をカウント
        uint256 activeCount = 0;
        for (uint256 i = 0; i < loanCount; i++) {
            if (loans[i].lender == lender && loans[i].state == LoanState.Funded) {
                activeCount++;
            }
        }
        
        // 正確なサイズの配列を作成
        uint256[] memory lenderLoans = new uint256[](activeCount);
        uint256 counter = 0;
        
        for (uint256 i = 0; i < loanCount && counter < activeCount; i++) {
            if (loans[i].lender == lender && loans[i].state == LoanState.Funded) {
                lenderLoans[counter] = i;
                counter++;
            }
        }
        
        return lenderLoans;
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

    // LTV比率を設定する関数（管理者用）
    function setLTVRatio(uint256 _ltvRatio) external onlyOwner {
        if (_ltvRatio > BASIS_POINTS) revert InvalidParameter();
        ltvRatio = _ltvRatio;
        emit LTVRatioUpdated(_ltvRatio);
    }

    /**
     * @notice Gets the statistics of the contract
     * @return totalLoans Total number of loans
     * @return activeLoans Number of funded loans
     * @return repaidLoans Number of repaid loans
     * @return defaultedLoans Number of defaulted loans
     * @return cancelledLoans Number of cancelled loans
     */
    function getStats() external view returns (
        uint256 totalLoans,
        uint256 activeLoans,
        uint256 repaidLoans,
        uint256 defaultedLoans,
        uint256 cancelledLoans
    ) {
        totalLoans = loanCount;
        
        for (uint256 i = 0; i < loanCount; i++) {
            if (loans[i].state == LoanState.Funded) {
                activeLoans++;
            } else if (loans[i].state == LoanState.Repaid) {
                repaidLoans++;
            } else if (loans[i].state == LoanState.Defaulted) {
                defaultedLoans++;
            } else if (loans[i].state == LoanState.Cancelled) {
                cancelledLoans++;
            }
        }
        
        return (totalLoans, activeLoans, repaidLoans, defaultedLoans, cancelledLoans);
    }
}
