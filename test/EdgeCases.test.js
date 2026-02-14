const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Edge Cases", function () {
    let socialLending;
    let owner, borrower, lender, otherUser, mockToken, mockPriceFeed;
    const LOAN_AMOUNT = ethers.parseEther("1");
    const MAX_INTEREST_RATE = 2000; // 20%
    const MAX_LOAN_DURATION = 365 * 24 * 60 * 60; // 365 days
    const COLLATERAL_AMOUNT = ethers.parseEther("2");
    const BASIS_POINTS = 10000;

    beforeEach(async function () {
        [owner, borrower, lender, otherUser] = await ethers.getSigners();

        // Deploy Mock Token
        const MockToken = await ethers.getContractFactory("MockERC20");
        mockToken = await MockToken.deploy("Mock", "MOCK", 18);
        await mockToken.waitForDeployment();

        // Deploy Mock Price Feed
        const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed");
        mockPriceFeed = await MockPriceFeed.deploy();
        await mockPriceFeed.waitForDeployment();
        await mockPriceFeed.setLatestPrice(ethers.parseUnits("1", 8)); // 1 ETH

        // Deploy Social Lending
        const SocialLending = await ethers.getContractFactory("SocialLendingWithCollateral");
        socialLending = await SocialLending.deploy(owner.address);
        await socialLending.waitForDeployment();

        // Setup collateral
        await socialLending.setCollateralTokenStatus(await mockToken.getAddress(), true);
        await socialLending.setCollateralTokenDecimals(await mockToken.getAddress(), 18);
        await socialLending.setPriceFeed(await mockToken.getAddress(), await mockPriceFeed.getAddress());

        // Mint tokens to borrower and lender
        await mockToken.mint(borrower.address, ethers.parseEther("1000"));
        await mockToken.connect(borrower).approve(await socialLending.getAddress(), ethers.parseEther("1000"));
    });

    it("should allow loan request with max interest rate", async function () {
        await expect(socialLending.connect(borrower).requestLoan(LOAN_AMOUNT, MAX_INTEREST_RATE, MAX_LOAN_DURATION, await mockToken.getAddress(), COLLATERAL_AMOUNT))
            .to.emit(socialLending, "LoanRequested");
    });

    it("should revert loan request with interest rate > max", async function () {
        await expect(socialLending.connect(borrower).requestLoan(LOAN_AMOUNT, MAX_INTEREST_RATE + 1, MAX_LOAN_DURATION, await mockToken.getAddress(), COLLATERAL_AMOUNT))
            .to.be.revertedWithCustomError(socialLending, "InvalidInterestRate");
    });

    it("should allow loan request with max duration", async function () {
        await expect(socialLending.connect(borrower).requestLoan(LOAN_AMOUNT, 100, MAX_LOAN_DURATION, await mockToken.getAddress(), COLLATERAL_AMOUNT))
            .to.emit(socialLending, "LoanRequested");
    });

    it("should revert loan request with duration > max", async function () {
        await expect(socialLending.connect(borrower).requestLoan(LOAN_AMOUNT, 100, MAX_LOAN_DURATION + 1, await mockToken.getAddress(), COLLATERAL_AMOUNT))
            .to.be.revertedWithCustomError(socialLending, "InvalidDuration");
    });

    it("should refund excess repayment amount", async function () {
        const interestRate = 1000; // 10%
        const duration = 30 * 24 * 60 * 60;

        await socialLending.connect(borrower).requestLoan(LOAN_AMOUNT, interestRate, duration, await mockToken.getAddress(), COLLATERAL_AMOUNT);
        const loanId = 0;

        await socialLending.connect(lender).fundLoan(loanId, { value: LOAN_AMOUNT });

        const repaymentAmount = await socialLending.loans(loanId).then(l => l.repaymentAmount);
        const excessAmount = ethers.parseEther("0.1");
        const totalPayment = repaymentAmount + excessAmount; // Correct logic: repayment + excess

        // Check lender balance change
        await expect(
            socialLending.connect(borrower).repayLoan(loanId, { value: totalPayment })
        ).to.changeEtherBalance(lender, repaymentAmount);

        // Verify contract balance is 0 (no stuck funds)
        expect(await ethers.provider.getBalance(await socialLending.getAddress())).to.equal(0);
    });

    it("should allow anyone to calling checkAndDeclareDefault on overdue loan", async function () {
        const duration = 100;
        await socialLending.connect(borrower).requestLoan(LOAN_AMOUNT, 100, duration, await mockToken.getAddress(), COLLATERAL_AMOUNT);
        const loanId = 0;
        await socialLending.connect(lender).fundLoan(loanId, { value: LOAN_AMOUNT });

        // Advance time
        await ethers.provider.send("evm_increaseTime", [duration + 1]);
        await ethers.provider.send("evm_mine");

        // Other user calls it
        await expect(socialLending.connect(otherUser).checkAndDeclareDefault(loanId))
            .to.emit(socialLending, "DefaultDeclared")
            .withArgs(loanId, lender.address);

        // Check state
        const loan = await socialLending.loans(loanId);
        expect(loan.state).to.equal(3); // Defaulted
    });
});
