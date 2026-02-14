const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Loan Cancellation", function () {
    let socialLending;
    let owner, borrower, lender, otherUser, mockToken, mockPriceFeed;
    const LOAN_AMOUNT = ethers.parseEther("1");
    const INTEREST_RATE = 500; // 5%
    const DURATION = 30 * 24 * 60 * 60; // 30 days
    const COLLATERAL_AMOUNT = ethers.parseEther("2"); // 150% collateral ratio requires > 1.5 ETH for 1 ETH loan
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

        // Mint tokens to borrower
        await mockToken.mint(borrower.address, ethers.parseEther("1000"));
        await mockToken.connect(borrower).approve(await socialLending.getAddress(), ethers.parseEther("1000"));
    });

    it("should allow borrower to cancel a requested loan", async function () {
        await socialLending.connect(borrower).requestLoan(LOAN_AMOUNT, INTEREST_RATE, DURATION, await mockToken.getAddress(), COLLATERAL_AMOUNT);
        const loanId = 0;

        // Check initial collateral balance of contract
        expect(await mockToken.balanceOf(await socialLending.getAddress())).to.equal(COLLATERAL_AMOUNT);

        await expect(socialLending.connect(borrower).cancelLoanRequest(loanId))
            .to.emit(socialLending, "LoanCancelled")
            .withArgs(loanId, borrower.address);

        // Verify state is Cancelled (4)
        const loan = await socialLending.loans(loanId);
        expect(loan.state).to.equal(4); // LoanState.Cancelled

        // Verify collateral returned
        expect(await mockToken.balanceOf(await socialLending.getAddress())).to.equal(0);
        expect(await mockToken.balanceOf(borrower.address)).to.equal(ethers.parseEther("1000"));
    });

    it("should revert if trying to cancel a funded loan", async function () {
        await socialLending.connect(borrower).requestLoan(LOAN_AMOUNT, INTEREST_RATE, DURATION, await mockToken.getAddress(), COLLATERAL_AMOUNT);
        const loanId = 0;

        await socialLending.connect(lender).fundLoan(loanId, { value: LOAN_AMOUNT });

        await expect(socialLending.connect(borrower).cancelLoanRequest(loanId))
            .to.be.revertedWithCustomError(socialLending, "InvalidLoanState");
    });

    it("should revert if user tries to cancel another user's loan", async function () {
        await socialLending.connect(borrower).requestLoan(LOAN_AMOUNT, INTEREST_RATE, DURATION, await mockToken.getAddress(), COLLATERAL_AMOUNT);
        const loanId = 0;

        await expect(socialLending.connect(otherUser).cancelLoanRequest(loanId))
            .to.be.revertedWithCustomError(socialLending, "Unauthorized");
    });

    it("should revert if trying to cancel a non-existent loan", async function () {
        await expect(socialLending.connect(borrower).cancelLoanRequest(999))
            .to.be.revertedWithCustomError(socialLending, "InvalidLoanId");
    });
});
