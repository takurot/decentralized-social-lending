const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SocialLendingWithCollateral", function () {
  let socialLending;
  let owner, feeRecipient, borrower, lender, mockToken, mockPriceFeed;
  const BASIS_POINTS = 10000;

  beforeEach(async function () {
    // コントラクトとアカウントの設定
    [owner, feeRecipient, borrower, lender, ...others] = await ethers.getSigners();

    // モックERC20トークンのデプロイ
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    mockToken = await MockERC20Factory.deploy("Mock Token", "MOCK", 18);

    // モックプライスフィードのデプロイ
    const MockPriceFeedFactory = await ethers.getContractFactory("MockPriceFeed");
    mockPriceFeed = await MockPriceFeedFactory.deploy();

    // メインコントラクトのデプロイ
    const SocialLendingFactory = await ethers.getContractFactory("SocialLendingWithCollateral");
    socialLending = await SocialLendingFactory.deploy(feeRecipient.address);

    // 担保トークンの設定
    await socialLending.setCollateralTokenStatus(mockToken.getAddress(), true);
    await socialLending.setCollateralTokenDecimals(mockToken.getAddress(), 18);
    await socialLending.setPriceFeed(mockToken.getAddress(), mockPriceFeed.getAddress());

    // 借り手にトークンを付与
    await mockToken.mint(borrower.address, ethers.parseEther("1000"));
    await mockToken.connect(borrower).approve(socialLending.getAddress(), ethers.parseEther("1000"));
  });

  describe("基本設定", function () {
    it("コンストラクタが正しく設定されていること", async function () {
      expect(await socialLending.feeRecipient()).to.equal(feeRecipient.address);
      expect(await socialLending.owner()).to.equal(owner.address);
    });

    it("担保トークンが正しく設定されていること", async function () {
      const tokenAddress = await mockToken.getAddress();
      const priceFeedAddress = await mockPriceFeed.getAddress();
      
      expect(await socialLending.allowedCollateralTokens(tokenAddress)).to.equal(true);
      expect(await socialLending.collateralTokenDecimals(tokenAddress)).to.equal(18);
      expect(await socialLending.priceFeeds(tokenAddress)).to.equal(priceFeedAddress);
    });
  });

  describe("ローンリクエスト", function () {
    it("有効なローンリクエストが作成できること", async function () {
      // プライスフィードの設定
      await mockPriceFeed.setLatestPrice(ethers.parseUnits("2000", 8)); // 1トークン = 2000 ETH

      const loanAmount = ethers.parseEther("1");
      const interestRate = 500; // 5%
      const duration = 30 * 24 * 60 * 60; // 30日
      const collateralAmount = ethers.parseEther("0.001"); // 0.001トークン = 2 ETH (LTV 50%で十分)
      const tokenAddress = await mockToken.getAddress();

      await expect(
        socialLending.connect(borrower).requestLoan(
          loanAmount,
          interestRate,
          duration,
          tokenAddress,
          collateralAmount
        )
      )
        .to.emit(socialLending, "LoanRequested")
        .withArgs(0, borrower.address, loanAmount, interestRate, duration, tokenAddress, collateralAmount);

      // ローン情報の確認
      const loan = await socialLending.loans(0);
      expect(loan.borrower).to.equal(borrower.address);
      expect(loan.principalAmount).to.equal(loanAmount);
      expect(loan.interestRate).to.equal(interestRate);
      expect(loan.state).to.equal(0); // Requested
    });

    it("担保価値が不足している場合はリクエストが失敗すること", async function () {
      // プライスフィードの設定
      await mockPriceFeed.setLatestPrice(ethers.parseUnits("2000", 8)); // 1トークン = 2000 ETH

      const loanAmount = ethers.parseEther("10");
      const interestRate = 500; // 5%
      const duration = 30 * 24 * 60 * 60; // 30日
      const collateralAmount = ethers.parseEther("0.001"); // 0.001トークン = 2 ETH (LTV 50%で不足)
      const tokenAddress = await mockToken.getAddress();

      await expect(
        socialLending.connect(borrower).requestLoan(
          loanAmount,
          interestRate,
          duration,
          tokenAddress,
          collateralAmount
        )
      ).to.be.revertedWithCustomError(socialLending, "InsufficientCollateralValue");
    });
  });

  describe("ローン資金提供", function () {
    beforeEach(async function () {
      // プライスフィードの設定
      await mockPriceFeed.setLatestPrice(ethers.parseUnits("2000", 8));

      // ローンリクエストの作成
      const loanAmount = ethers.parseEther("1");
      const interestRate = 500; // 5%
      const duration = 30 * 24 * 60 * 60; // 30日
      const collateralAmount = ethers.parseEther("0.001");
      const tokenAddress = await mockToken.getAddress();

      await socialLending.connect(borrower).requestLoan(
        loanAmount,
        interestRate,
        duration,
        tokenAddress,
        collateralAmount
      );
    });

    it("貸し手がローンに資金提供できること", async function () {
      const loanId = 0;
      const loan = await socialLending.loans(loanId);
      
      await expect(
        socialLending.connect(lender).fundLoan(loanId, { value: loan.principalAmount })
      )
        .to.emit(socialLending, "LoanFunded")
        .withArgs(loanId, lender.address);

      // ローン状態の確認
      const updatedLoan = await socialLending.loans(loanId);
      expect(updatedLoan.lender).to.equal(lender.address);
      expect(updatedLoan.state).to.equal(1); // Funded
      expect(updatedLoan.startTime).to.not.equal(0);
    });

    it("不正確な金額での資金提供が失敗すること", async function () {
      const loanId = 0;
      const loan = await socialLending.loans(loanId);
      const incorrectAmount = BigInt(loan.principalAmount) + ethers.parseEther("0.1");

      await expect(
        socialLending.connect(lender).fundLoan(loanId, { value: incorrectAmount })
      ).to.be.revertedWithCustomError(socialLending, "IncorrectFundingAmount");
    });
  });

  describe("担保率計算", function () {
    beforeEach(async function () {
      await mockPriceFeed.setLatestPrice(ethers.parseUnits("2000", 8));

      const loanAmount = ethers.parseEther("1");
      const interestRate = 500; // 5%
      const duration = 30 * 24 * 60 * 60; // 30日
      const collateralAmount = ethers.parseEther("0.001");
      const tokenAddress = await mockToken.getAddress();

      await socialLending.connect(borrower).requestLoan(
        loanAmount,
        interestRate,
        duration,
        tokenAddress,
        collateralAmount
      );

      const loanId = 0;
      const loan = await socialLending.loans(loanId);
      await socialLending.connect(lender).fundLoan(loanId, { value: loan.principalAmount });
    });

    it("資金提供後の担保率が正しく計算されること", async function () {
      const loanId = 0;
      const price = ethers.parseUnits("2000", 8);
      const collateralAmount = ethers.parseEther("0.001");
      const collateralValue = (collateralAmount * price) / 10n ** 8n;

      const loan = await socialLending.loans(loanId);
      const expectedRatio = (collateralValue * BigInt(BASIS_POINTS)) / BigInt(loan.remainingRepaymentAmount);

      expect(await socialLending.getCollateralizationRatio(loanId)).to.equal(expectedRatio);
    });
  });

  describe("ローン返済", function () {
    beforeEach(async function () {
      // プライスフィードの設定
      await mockPriceFeed.setLatestPrice(ethers.parseUnits("2000", 8));

      // ローンリクエストの作成
      const loanAmount = ethers.parseEther("1");
      const interestRate = 500; // 5%
      const duration = 30 * 24 * 60 * 60; // 30日
      const collateralAmount = ethers.parseEther("0.001");
      const tokenAddress = await mockToken.getAddress();

      await socialLending.connect(borrower).requestLoan(
        loanAmount,
        interestRate,
        duration,
        tokenAddress,
        collateralAmount
      );

      // 資金提供
      const loanId = 0;
      const loan = await socialLending.loans(loanId);
      await socialLending.connect(lender).fundLoan(loanId, { value: loan.principalAmount });
    });

    it("借り手が部分返済できること", async function () {
      const loanId = 0;
      const loan = await socialLending.loans(loanId);
      const partialAmount = BigInt(loan.remainingRepaymentAmount) / 2n;

      await expect(
        socialLending.connect(borrower).repayLoan(loanId, { value: partialAmount })
      )
        .to.emit(socialLending, "LoanPartiallyRepaid")
        .withArgs(loanId, borrower.address, partialAmount, BigInt(loan.remainingRepaymentAmount) - partialAmount);

      // 残りの返済額の確認
      const updatedLoan = await socialLending.loans(loanId);
      expect(updatedLoan.remainingRepaymentAmount).to.equal(BigInt(loan.remainingRepaymentAmount) - partialAmount);
      expect(updatedLoan.state).to.equal(1); // Still Funded
    });

    it("借り手が全額返済できること", async function () {
      const loanId = 0;
      const loan = await socialLending.loans(loanId);

      await expect(
        socialLending.connect(borrower).repayLoan(loanId, { value: loan.remainingRepaymentAmount })
      )
        .to.emit(socialLending, "LoanRepaid")
        .withArgs(loanId, borrower.address, lender.address, loan.remainingRepaymentAmount);

      // ローン状態の確認
      const updatedLoan = await socialLending.loans(loanId);
      expect(updatedLoan.remainingRepaymentAmount).to.equal(0);
      expect(updatedLoan.state).to.equal(2); // Repaid
    });
  });

  describe("デフォルト処理", function () {
    beforeEach(async function () {
      // プライスフィードの設定
      await mockPriceFeed.setLatestPrice(ethers.parseUnits("2000", 8));

      // ローンリクエストの作成
      const loanAmount = ethers.parseEther("1");
      const interestRate = 500; // 5%
      const duration = 30 * 24 * 60 * 60; // 30日
      const collateralAmount = ethers.parseEther("0.001");
      const tokenAddress = await mockToken.getAddress();

      await socialLending.connect(borrower).requestLoan(
        loanAmount,
        interestRate,
        duration,
        tokenAddress,
        collateralAmount
      );

      // 資金提供
      const loanId = 0;
      const loan = await socialLending.loans(loanId);
      await socialLending.connect(lender).fundLoan(loanId, { value: loan.principalAmount });
    });

    it("期限切れ後に貸し手がデフォルトを宣言できること", async function () {
      const loanId = 0;
      
      // 時間を進める
      await ethers.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]); // 31日
      await ethers.provider.send("evm_mine");

      await expect(
        socialLending.connect(lender).declareDefault(loanId)
      )
        .to.emit(socialLending, "DefaultDeclared")
        .withArgs(loanId, lender.address);

      // ローン状態の確認
      const updatedLoan = await socialLending.loans(loanId);
      expect(updatedLoan.state).to.equal(3); // Defaulted
    });

    it("期限前にデフォルト宣言が失敗すること", async function () {
      const loanId = 0;
      
      await expect(
        socialLending.connect(lender).declareDefault(loanId)
      ).to.be.revertedWithCustomError(socialLending, "LoanNotExpired");
    });
  });
}); 