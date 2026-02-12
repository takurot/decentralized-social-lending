const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SocialLendingWithCollateral Security", function () {
    let socialLending;
    let owner, borrower, lender, mockToken, mockPriceFeed;
    const BASIS_POINTS = 10000;

    beforeEach(async function () {
        [owner, borrower, lender] = await ethers.getSigners();

        const MockERC20Factory = await ethers.getContractFactory("MockERC20");
        mockToken = await MockERC20Factory.deploy("Mock Token", "MOCK", 18);

        const MockPriceFeedFactory = await ethers.getContractFactory("MockPriceFeed");
        mockPriceFeed = await MockPriceFeedFactory.deploy();

        const SocialLendingFactory = await ethers.getContractFactory("SocialLendingWithCollateral");
        socialLending = await SocialLendingFactory.deploy(owner.address);

        await socialLending.setCollateralTokenStatus(await mockToken.getAddress(), true);
        await socialLending.setCollateralTokenDecimals(await mockToken.getAddress(), 18);
        await socialLending.setPriceFeed(await mockToken.getAddress(), await mockPriceFeed.getAddress());

        await mockToken.mint(borrower.address, ethers.parseEther("1000"));
        await mockToken.connect(borrower).approve(await socialLending.getAddress(), ethers.parseEther("1000"));

        // Set price: 1 Token = 2000 ETH
        await mockPriceFeed.setLatestPrice(ethers.parseUnits("2000", 8));
    });

    describe("Borrowing Limits", function () {
        it("should revert if loan amount exceeds maxLoanAmount", async function () {
            const maxLoan = await socialLending.maxLoanAmount();
            const loanAmount = maxLoan + 1n; // Exceeds max
            const collateralAmount = ethers.parseEther("10"); // Plenty of collateral

            await expect(
                socialLending.connect(borrower).requestLoan(
                    loanAmount,
                    500,
                    30 * 86400,
                    await mockToken.getAddress(),
                    collateralAmount
                )
            ).to.be.revertedWithCustomError(socialLending, "LoanTooLarge");
        });

        it("should revert if borrower exceeds maxActiveLoansPerBorrower", async function () {
            const maxActive = await socialLending.maxActiveLoansPerBorrower();
            const loanAmount = ethers.parseEther("0.1");
            const collateralAmount = ethers.parseEther("0.1"); // 0.1 Token = 200 ETH > 0.15 ETH required

            for (let i = 0; i < maxActive; i++) {
                await socialLending.connect(borrower).requestLoan(
                    loanAmount,
                    500,
                    30 * 86400,
                    await mockToken.getAddress(),
                    collateralAmount
                )
            }

            // 4th request should fail
            await expect(
                socialLending.connect(borrower).requestLoan(
                    loanAmount,
                    500,
                    30 * 86400,
                    await mockToken.getAddress(),
                    collateralAmount
                )
            ).to.be.revertedWithCustomError(socialLending, "TooManyActiveLoans");
        });
    });

    describe("Locked Collateral Integrity", function () {
        it("should track locked collateral correctly", async function () {
            const loanAmount = ethers.parseEther("1");
            const collateralAmount = ethers.parseEther("0.001"); // 2 ETH value > 1.5 ETH required

            await socialLending.connect(borrower).requestLoan(
                loanAmount,
                500,
                30 * 86400,
                await mockToken.getAddress(),
                collateralAmount
            );

            const locked = await socialLending.lockedCollateral(await mockToken.getAddress());
            expect(locked).to.equal(collateralAmount);
        });

        it("should prevent rescuing locked collateral", async function () {
            const loanAmount = ethers.parseEther("1");
            const collateralAmount = ethers.parseEther("0.001");

            await socialLending.connect(borrower).requestLoan(
                loanAmount,
                500,
                30 * 86400,
                await mockToken.getAddress(),
                collateralAmount
            );

            // Try to rescue full balance (which is all locked)
            await expect(
                socialLending.connect(owner).rescueTokens(
                    await mockToken.getAddress(),
                    collateralAmount,
                    owner.address
                )
            ).to.be.revertedWithCustomError(socialLending, "InsufficientUnlockedCollateral");
        });

        it("should allow rescuing unlocked collateral", async function () {
            // Mint extra to contract
            const extraAmount = ethers.parseEther("1.0");
            await mockToken.mint(await socialLending.getAddress(), extraAmount);

            // Now contract has extraAmount. lockedCollateral is 0.
            // Rescue should succeed.
            await expect(
                socialLending.connect(owner).rescueTokens(
                    await mockToken.getAddress(),
                    extraAmount,
                    owner.address
                )
            ).not.to.be.reverted;

            const locked = await socialLending.lockedCollateral(await mockToken.getAddress());
            expect(locked).to.equal(0);
        });
    });

    describe("Interest Calculation", function () {
        it("should calculate interest correctly using Math.mulDiv", async function () {
            // This test verifies the loan creation calculation implicitly by checking repaymentAmount
            const loanAmount = ethers.parseEther("1");
            const interestRate = 1000; // 10%
            const duration = 365 * 24 * 60 * 60; // 1 year
            const collateralAmount = ethers.parseEther("0.01"); // Plenty

            await socialLending.connect(borrower).requestLoan(
                loanAmount,
                interestRate,
                duration,
                await mockToken.getAddress(),
                collateralAmount
            );

            const loan = await socialLending.loans(0);
            // Interest = 1 ETH * 10% * 1 year / 1 year = 0.1 ETH
            const expectedInterest = ethers.parseEther("0.1");
            const expectedRepayment = loanAmount + expectedInterest;

            expect(loan.repaymentAmount).to.equal(expectedRepayment);
        });
    });
});
