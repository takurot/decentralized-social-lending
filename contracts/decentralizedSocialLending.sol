// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// OpenZeppelinのライブラリをインポート
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

// Chainlinkのオラクルインターフェースをインポート
import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

contract SocialLendingWithCollateral is ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;

    // 定数
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant MAX_INTEREST_RATE = 2000; // 20%
    uint256 public constant MAX_PLATFORM_FEE = 500;  // 5%
    uint256 public constant SECONDS_PER_YEAR = 365 days;

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
    event LoanPartiallyRepaid(uint256 indexed loanId, address indexed borrower, uint256 amountRepaid);
    event LoanRepaid(uint256 indexed loanId, address indexed borrower, address indexed lender, uint256 repaymentAmount);
    event DefaultDeclared(uint256 indexed loanId, address indexed lender);
    event LoanCancelled(uint256 indexed loanId, address indexed borrower);
    event PriceFeedUpdated(address indexed token, address indexed priceFeed);
    event PlatformFeeUpdated(uint256 newFee);
    event FeeRecipientUpdated(address indexed newRecipient);
    event LTVRatioUpdated(uint256 newRatio);
    event CollateralTokenStatusUpdated(address indexed token, bool allowed);

    // コンストラクタ
    constructor(address _feeRecipient) {
        require(_feeRecipient != address(0), "Fee recipient cannot be zero address");
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
        require(msg.sender == loans[loanId].borrower, "Only borrower can call this function");
        _;
    }

    // 修飾子: 貸し手のみ
    modifier onlyLender(uint256 loanId) {
        require(msg.sender == loans[loanId].lender, "Only lender can call this function");
        _;
    }

    // 修飾子: 有効なローンIDかチェック
    modifier validLoanId(uint256 loanId) {
        require(loanId < loanCount, "Invalid loan ID");
        _;
    }

    // 緊急停止機能
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // 担保トークンの許可状態を設定する関数
    function setCollateralTokenStatus(address token, bool allowed) external onlyOwner {
        require(token != address(0), "Invalid token address");
        allowedCollateralTokens[token] = allowed;
        emit CollateralTokenStatusUpdated(token, allowed);
    }

    // 担保トークンに対するプライスフィードを設定する関数（管理者用）
    function setPriceFeed(address token, address priceFeed) external onlyOwner {
        require(token != address(0), "Invalid token address");
        require(priceFeed != address(0), "Invalid price feed address");
        priceFeeds[token] = priceFeed;
        emit PriceFeedUpdated(token, priceFeed);
    }

    // 借り手がローンをリクエストする関数
    function requestLoan(
        uint256 amount,
        uint256 interestRate,
        uint256 duration,
        address collateralToken,
        uint256 collateralAmount
    ) external nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be greater than zero");
        require(interestRate > 0 && interestRate <= MAX_INTEREST_RATE, "Interest rate must be between 0 and 20%");
        require(duration > 0, "Duration must be greater than zero");
        require(collateralAmount > 0, "Collateral must be greater than zero");
        require(allowedCollateralTokens[collateralToken], "Collateral token not allowed");

        // 担保価値の評価
        uint256 collateralValueInETH = getCollateralValueInETH(collateralToken, collateralAmount);
        uint256 requiredCollateralValueInETH = (amount * ltvRatio) / BASIS_POINTS;
        require(collateralValueInETH >= requiredCollateralValueInETH, "Insufficient collateral value");

        // 担保のデポジット
        IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), collateralAmount);

        uint256 loanId = loanCount++;

        // 単利による返済総額の計算
        uint256 repaymentAmount = amount + ((amount * interestRate * duration) / (SECONDS_PER_YEAR * BASIS_POINTS));

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

    // 借り手が資金提供前にローンをキャンセルする関数
    function cancelLoanRequest(uint256 loanId) external nonReentrant onlyBorrower(loanId) validLoanId(loanId) whenNotPaused {
        Loan storage loan = loans[loanId];
        require(loan.state == LoanState.Requested, "Loan cannot be cancelled");

        // 担保の返却
        IERC20(loan.collateralToken).safeTransfer(loan.borrower, loan.collateralAmount);

        loan.state = LoanState.Cancelled;
        borrowerActiveLoans[loan.borrower]--;

        emit LoanCancelled(loanId, loan.borrower);
    }

    // 貸し手がローンを資金提供する関数
    function fundLoan(uint256 loanId) external payable nonReentrant validLoanId(loanId) whenNotPaused {
        Loan storage loan = loans[loanId];
        require(loan.state == LoanState.Requested, "Loan is not available for funding");
        require(msg.value == loan.principalAmount, "Incorrect funding amount");
        require(loan.borrower != msg.sender, "Cannot fund your own loan");

        loan.lender = payable(msg.sender);
        loan.startTime = block.timestamp;
        loan.state = LoanState.Funded;

        // プラットフォーム手数料の計算と送金
        uint256 feeAmount = (msg.value * platformFee) / BASIS_POINTS;
        (bool feeSuccess, ) = feeRecipient.call{value: feeAmount}("");
        require(feeSuccess, "Failed to transfer platform fee");

        // 借り手への送金（手数料を引いた額）
        uint256 amountToBorrower = msg.value - feeAmount;
        (bool success, ) = loan.borrower.call{value: amountToBorrower}("");
        require(success, "Failed to send Ether to borrower");

        lenderActiveLoans[msg.sender]++;

        emit LoanFunded(loanId, msg.sender);
    }

    // 借り手が返済する関数（部分返済をサポート）
    function repayLoan(uint256 loanId) external payable nonReentrant onlyBorrower(loanId) validLoanId(loanId) whenNotPaused {
        Loan storage loan = loans[loanId];
        require(loan.state == LoanState.Funded, "Loan is not active");
        require(msg.value > 0, "Repayment amount must be greater than zero");

        uint256 amount = msg.value;

        if (amount >= loan.remainingRepaymentAmount) {
            // 全額返済
            uint256 excessAmount = amount - loan.remainingRepaymentAmount;
            amount = loan.remainingRepaymentAmount; // 貸し手への送金額を調整
            loan.remainingRepaymentAmount = 0;
            loan.state = LoanState.Repaid;

            // 担保の返却
            IERC20(loan.collateralToken).safeTransfer(loan.borrower, loan.collateralAmount);

            // 貸し手への送金
            (bool success, ) = loan.lender.call{value: amount}("");
            require(success, "Failed to send Ether to lender");

            // 余剰分を借り手に返却
            if (excessAmount > 0) {
                (bool excessSuccess, ) = loan.borrower.call{value: excessAmount}("");
                require(excessSuccess, "Failed to return excess Ether to borrower");
            }

            borrowerActiveLoans[loan.borrower]--;
            lenderActiveLoans[loan.lender]--;

            emit LoanRepaid(loanId, loan.borrower, loan.lender, amount);
        } else {
            // 部分返済
            loan.remainingRepaymentAmount -= amount;

            // 貸し手への送金
            (bool success, ) = loan.lender.call{value: amount}("");
            require(success, "Failed to send Ether to lender");

            emit LoanPartiallyRepaid(loanId, loan.borrower, amount);
        }
    }

    // 貸し手がデフォルトを宣言して担保を取得する関数
    function declareDefault(uint256 loanId) external nonReentrant onlyLender(loanId) validLoanId(loanId) whenNotPaused {
        Loan storage loan = loans[loanId];
        require(loan.state == LoanState.Funded, "Loan is not active");
        require(block.timestamp > loan.startTime + loan.duration, "Loan duration has not yet expired");
        require(loan.remainingRepaymentAmount > 0, "Loan has already been repaid");

        loan.state = LoanState.Defaulted;

        // 担保の貸し手への移転
        IERC20(loan.collateralToken).safeTransfer(loan.lender, loan.collateralAmount);

        borrowerActiveLoans[loan.borrower]--;
        lenderActiveLoans[loan.lender]--;

        emit DefaultDeclared(loanId, loan.lender);
    }

    // 自動的にデフォルトを検出して担保を清算する関数（誰でも呼び出し可能）
    function checkAndDeclareDefault(uint256 loanId) external nonReentrant validLoanId(loanId) whenNotPaused {
        Loan storage loan = loans[loanId];
        require(loan.state == LoanState.Funded, "Loan is not active");
        require(block.timestamp > loan.startTime + loan.duration, "Loan duration has not yet expired");
        require(loan.remainingRepaymentAmount > 0, "Loan has already been repaid");

        loan.state = LoanState.Defaulted;

        // 担保の貸し手への移転
        IERC20(loan.collateralToken).safeTransfer(loan.lender, loan.collateralAmount);

        borrowerActiveLoans[loan.borrower]--;
        lenderActiveLoans[loan.lender]--;

        emit DefaultDeclared(loanId, loan.lender);
    }

    // 担保のETHにおける価値を取得する関数
    function getCollateralValueInETH(address collateralToken, uint256 collateralAmount) public view returns (uint256) {
        address priceFeedAddress = priceFeeds[collateralToken];
        require(priceFeedAddress != address(0), "Price feed not available for collateral token");

        AggregatorV3Interface priceFeed = AggregatorV3Interface(priceFeedAddress);
        (, int256 price, , , ) = priceFeed.latestRoundData();
        require(price > 0, "Invalid price data");

        uint8 decimals = priceFeed.decimals();

        uint256 collateralValueInETH = (collateralAmount * uint256(price)) / (10 ** uint256(decimals));
        return collateralValueInETH;
    }

    // 借り手のローン情報を取得する関数
    function getBorrowerLoans(address borrower) external view returns (uint256[] memory) {
        uint256[] memory borrowerLoans = new uint256[](borrowerActiveLoans[borrower]);
        uint256 counter = 0;
        
        for (uint256 i = 0; i < loanCount; i++) {
            if (loans[i].borrower == borrower && 
                (loans[i].state == LoanState.Requested || loans[i].state == LoanState.Funded)) {
                borrowerLoans[counter] = i;
                counter++;
            }
        }
        
        return borrowerLoans;
    }

    // 貸し手のローン情報を取得する関数
    function getLenderLoans(address lender) external view returns (uint256[] memory) {
        uint256[] memory lenderLoans = new uint256[](lenderActiveLoans[lender]);
        uint256 counter = 0;
        
        for (uint256 i = 0; i < loanCount; i++) {
            if (loans[i].lender == lender && loans[i].state == LoanState.Funded) {
                lenderLoans[counter] = i;
                counter++;
            }
        }
        
        return lenderLoans;
    }

    // プラットフォーム手数料を設定する関数（管理者用）
    function setPlatformFee(uint256 _platformFee) external onlyOwner {
        require(_platformFee <= MAX_PLATFORM_FEE, "Platform fee cannot exceed 5%");
        platformFee = _platformFee;
        emit PlatformFeeUpdated(_platformFee);
    }

    // 手数料受取者を設定する関数（管理者用）
    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        require(_feeRecipient != address(0), "Invalid fee recipient address");
        feeRecipient = _feeRecipient;
        emit FeeRecipientUpdated(_feeRecipient);
    }

    // LTV比率を設定する関数（管理者用）
    function setLTVRatio(uint256 _ltvRatio) external onlyOwner {
        require(_ltvRatio <= BASIS_POINTS, "LTV ratio cannot exceed 100%");
        ltvRatio = _ltvRatio;
        emit LTVRatioUpdated(_ltvRatio);
    }

    // コントラクトの統計情報を取得する関数
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
