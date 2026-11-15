const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SocialLendingWithCollateral", function () {
  let socialLending;
  let owner, feeRecipient, borrower, lender, mockToken, mockPriceFeed;
  const BASIS_POINTS = 10000;

  beforeEach(async function () {
    // Set up contracts and accounts
    [owner, feeRecipient, borrower, lender, ...others] = await ethers.getSigners();

    // Deploy mock ERC20 token
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    mockToken = await MockERC20Factory.deploy("Mock Token", "MOCK", 18);

    // Deploy mock price feed
    const MockPriceFeedFactory = await ethers.getContractFactory("MockPriceFeed");
    mockPriceFeed = await MockPriceFeedFactory.deploy();

    // Deploy main lending contract
    const SocialLendingFactory = await ethers.getContractFactory("SocialLendingWithCollateral");
    socialLending = await SocialLendingFactory.deploy(feeRecipient.address);

    // Configure collateral token
    await socialLending.setCollateralTokenStatus(mockToken.getAddress(), true);
    await socialLending.setCollateralTokenDecimals(mockToken.getAddress(), 18);
    await socialLending.setPriceFeed(mockToken.getAddress(), mockPriceFeed.getAddress());

    // Mint tokens to borrower
    await mockToken.mint(borrower.address, ethers.parseEther("1000"));
    await mockToken.connect(borrower).approve(socialLending.getAddress(), ethers.parseEther("1000"));
  });

  describe("Basic Configuration", function () {
    it("should initialize constructor parameters correctly", async function () {
      expect(await socialLending.feeRecipient()).to.equal(feeRecipient.address);
      expect(await socialLending.owner()).to.equal(owner.address);
    });

    it("should configure collateral token correctly", async function () {
      const tokenAddress = await mockToken.getAddress();
      const priceFeedAddress = await mockPriceFeed.getAddress();

      expect(await socialLending.allowedCollateralTokens(tokenAddress)).to.equal(true);
      expect(await socialLending.collateralTokenDecimals(tokenAddress)).to.equal(18);
      expect(await socialLending.priceFeeds(tokenAddress)).to.equal(priceFeedAddress);
    });
  });

  describe("Security Validations", function () {
    it("should reject zero-address collateral token", async function () {
      await mockPriceFeed.setLatestPrice(ethers.parseUnits("2000", 8));

      const loanAmount = ethers.parseEther("1");
      const interestRate = 500;
      const duration = 30 * 24 * 60 * 60;
      const collateralAmount = ethers.parseEther("1");

      await expect(
        socialLending
          .connect(borrower)
          .requestLoan(loanAmount, interestRate, duration, ethers.ZeroAddress, collateralAmount)
      ).to.be.revertedWithCustomError(socialLending, "InvalidAddress");
    });

    it("should reject decimals greater than 18", async function () {
      const tokenAddress = await mockToken.getAddress();
      await expect(
        socialLending.setCollateralTokenDecimals(tokenAddress, 19)
      ).to.be.revertedWithCustomError(socialLending, "InvalidParameter");
    });

    it("should detect invalid or stale oracle price data", async function () {
      const tokenAddress = await mockToken.getAddress();
      const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      await mockPriceFeed.setPriceData(
        ethers.parseUnits("2000", 8),
        1n,
        0n,
        now,
        1n
      );

      await expect(
        socialLending.getCollateralValueInETH(tokenAddress, 1)
      ).to.be.revertedWithCustomError(socialLending, "InvalidPriceData");
    });
  });

  describe("Loan Requests", function () {
    it("should create a valid loan request", async function () {
      // Configure price feed
      await mockPriceFeed.setLatestPrice(ethers.parseUnits("2000", 8)); // 1 token = 2000 ETH

      const loanAmount = ethers.parseEther("1");
      const interestRate = 500; // 5%
      const duration = 30 * 24 * 60 * 60; // 30 days
      const collateralAmount = ethers.parseEther("0.001"); // 0.001 token = 2 ETH (sufficient for 150% collateral ratio)
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

      // Verify loan details
      const loan = await socialLending.loans(0);
      expect(loan.borrower).to.equal(borrower.address);
      expect(loan.principalAmount).to.equal(loanAmount);
      expect(loan.interestRate).to.equal(interestRate);
      expect(loan.state).to.equal(0); // Requested
    });

    it("should revert when collateral value is insufficient", async function () {
      // Configure price feed
      await mockPriceFeed.setLatestPrice(ethers.parseUnits("2000", 8)); // 1 token = 2000 ETH

      const loanAmount = ethers.parseEther("10");
      const interestRate = 500; // 5%
      const duration = 30 * 24 * 60 * 60; // 30 days
      const collateralAmount = ethers.parseEther("0.001"); // 0.001 token = 2 ETH (insufficient for 150% collateral ratio)
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

  describe("Loan Funding", function () {
    beforeEach(async function () {
      // Configure price feed
      await mockPriceFeed.setLatestPrice(ethers.parseUnits("2000", 8));

      // Create loan request
      const loanAmount = ethers.parseEther("1");
      const interestRate = 500; // 5%
      const duration = 30 * 24 * 60 * 60; // 30 days
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

    it("should allow lender to fund a loan", async function () {
      const loanId = 0;
      const loan = await socialLending.loans(loanId);

      await expect(
        socialLending.connect(lender).fundLoan(loanId, { value: loan.principalAmount })
      )
        .to.emit(socialLending, "LoanFunded")
        .withArgs(loanId, lender.address);

      // Verify loan state
      const updatedLoan = await socialLending.loans(loanId);
      expect(updatedLoan.lender).to.equal(lender.address);
      expect(updatedLoan.state).to.equal(1); // Funded
      expect(updatedLoan.startTime).to.not.equal(0);
    });

    it("should revert when funding amount is incorrect", async function () {
      const loanId = 0;
      const loan = await socialLending.loans(loanId);
      const incorrectAmount = BigInt(loan.principalAmount) + ethers.parseEther("0.1");

      await expect(
        socialLending.connect(lender).fundLoan(loanId, { value: incorrectAmount })
      ).to.be.revertedWithCustomError(socialLending, "IncorrectFundingAmount");
    });
  });

  describe("Collateralization Ratio Calculation", function () {
    beforeEach(async function () {
      await mockPriceFeed.setLatestPrice(ethers.parseUnits("2000", 8));

      const loanAmount = ethers.parseEther("1");
      const interestRate = 500; // 5%
      const duration = 30 * 24 * 60 * 60; // 30 days
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

    it("should calculate collateralization ratio accurately after funding", async function () {
      const loanId = 0;
      const price = ethers.parseUnits("2000", 8);
      const collateralAmount = ethers.parseEther("0.001");
      const collateralValue = (collateralAmount * price) / 10n ** 8n;

      const loan = await socialLending.loans(loanId);
      const expectedRatio = (collateralValue * BigInt(BASIS_POINTS)) / BigInt(loan.remainingRepaymentAmount);

      expect(await socialLending.getCollateralizationRatio(loanId)).to.equal(expectedRatio);
    });
  });

  describe("Loan Repayment", function () {
    beforeEach(async function () {
      // Configure price feed
      await mockPriceFeed.setLatestPrice(ethers.parseUnits("2000", 8));

      // Create loan request
      const loanAmount = ethers.parseEther("1");
      const interestRate = 500; // 5%
      const duration = 30 * 24 * 60 * 60; // 30 days
      const collateralAmount = ethers.parseEther("0.001");
      const tokenAddress = await mockToken.getAddress();

      await socialLending.connect(borrower).requestLoan(
        loanAmount,
        interestRate,
        duration,
        tokenAddress,
        collateralAmount
      );

      // Fund the loan
      const loanId = 0;
      const loan = await socialLending.loans(loanId);
      await socialLending.connect(lender).fundLoan(loanId, { value: loan.principalAmount });
    });

    it("should allow borrower to make a partial repayment", async function () {
      const loanId = 0;
      const loan = await socialLending.loans(loanId);
      const partialAmount = BigInt(loan.remainingRepaymentAmount) / 2n;

      await expect(
        socialLending.connect(borrower).repayLoan(loanId, { value: partialAmount })
      )
        .to.emit(socialLending, "LoanPartiallyRepaid")
        .withArgs(loanId, borrower.address, partialAmount, BigInt(loan.remainingRepaymentAmount) - partialAmount);

      // Verify remaining repayment amount
      const updatedLoan = await socialLending.loans(loanId);
      expect(updatedLoan.remainingRepaymentAmount).to.equal(BigInt(loan.remainingRepaymentAmount) - partialAmount);
      expect(updatedLoan.state).to.equal(1); // Still Funded
    });

    it("should allow borrower to repay the loan in full", async function () {
      const loanId = 0;
      const loan = await socialLending.loans(loanId);

      await expect(
        socialLending.connect(borrower).repayLoan(loanId, { value: loan.remainingRepaymentAmount })
      )
        .to.emit(socialLending, "LoanRepaid")
        .withArgs(loanId, borrower.address, lender.address, loan.remainingRepaymentAmount);

      // Verify loan state
      const updatedLoan = await socialLending.loans(loanId);
      expect(updatedLoan.remainingRepaymentAmount).to.equal(0);
      expect(updatedLoan.state).to.equal(2); // Repaid
    });
  });

  describe("Default Handling", function () {
    beforeEach(async function () {
      // Configure price feed
      await mockPriceFeed.setLatestPrice(ethers.parseUnits("2000", 8));

      // Create loan request
      const loanAmount = ethers.parseEther("1");
      const interestRate = 500; // 5%
      const duration = 30 * 24 * 60 * 60; // 30 days
      const collateralAmount = ethers.parseEther("0.001");
      const tokenAddress = await mockToken.getAddress();

      await socialLending.connect(borrower).requestLoan(
        loanAmount,
        interestRate,
        duration,
        tokenAddress,
        collateralAmount
      );

      // Fund the loan
      const loanId = 0;
      const loan = await socialLending.loans(loanId);
      await socialLending.connect(lender).fundLoan(loanId, { value: loan.principalAmount });
    });

    it("should allow lender to declare default after expiration", async function () {
      const loanId = 0;

      // Advance block timestamp (30-day duration + 3-day grace period)
      await ethers.provider.send("evm_increaseTime", [34 * 24 * 60 * 60]); // 34 days
      await ethers.provider.send("evm_mine");

      await expect(
        socialLending.connect(lender).declareDefault(loanId)
      )
        .to.emit(socialLending, "DefaultDeclared")
        .withArgs(loanId, lender.address);

      // Verify loan state
      const updatedLoan = await socialLending.loans(loanId);
      expect(updatedLoan.state).to.equal(3); // Defaulted
    });

    it("should revert default declaration before expiration", async function () {
      const loanId = 0;

      await expect(
        socialLending.connect(lender).declareDefault(loanId)
      ).to.be.revertedWithCustomError(socialLending, "LoanNotExpired");
    });
  });
}); 