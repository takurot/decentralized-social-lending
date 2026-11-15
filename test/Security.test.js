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

        it("should revert if duration exceeds MAX_LOAN_DURATION", async function () {
            const maxDuration = await socialLending.MAX_LOAN_DURATION();
            const loanAmount = ethers.parseEther("1");
            const collateralAmount = ethers.parseEther("10");

            await expect(
                socialLending.connect(borrower).requestLoan(
                    loanAmount,
                    500,
                    maxDuration + 1n,
                    await mockToken.getAddress(),
                    collateralAmount
                )
            ).to.be.revertedWithCustomError(socialLending, "InvalidDuration");
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

        it("should revert rescueTokens if token address is 0", async function () {
            await expect(
                socialLending.connect(owner).rescueTokens(
                    ethers.ZeroAddress,
                    100,
                    owner.address
                )
            ).to.be.revertedWithCustomError(socialLending, "InvalidAddress");
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

    describe("Fee-on-Transfer Collateral Accounting (Issue #11)", function () {
        let feeToken, feeTokenAddr;

        beforeEach(async function () {
            const FeeTokenFactory = await ethers.getContractFactory("MockFeeOnTransferERC20");
            // 5% (500 bps) fee sent to owner
            feeToken = await FeeTokenFactory.deploy("Fee Token", "FEE", 500, owner.address);
            feeTokenAddr = await feeToken.getAddress();

            await socialLending.setCollateralTokenStatus(feeTokenAddr, true);
            await socialLending.setCollateralTokenDecimals(feeTokenAddr, 18);
            await socialLending.setPriceFeed(feeTokenAddr, await mockPriceFeed.getAddress());

            await feeToken.mint(borrower.address, ethers.parseEther("100"));
            await feeToken.connect(borrower).approve(await socialLending.getAddress(), ethers.parseEther("100"));

            // 1 token = 1 ETH
            await mockPriceFeed.setLatestPrice(ethers.parseUnits("1", 8));
        });

        it("should track actual received collateral in lockedCollateral and loan.collateralAmount", async function () {
            const loanAmount = ethers.parseEther("1");
            const sentCollateral = ethers.parseEther("2"); // 5% fee => 1.9 ETH received (> 1.5 ETH required)
            const expectedReceived = ethers.parseEther("1.9");

            await expect(
                socialLending.connect(borrower).requestLoan(
                    loanAmount,
                    500,
                    30 * 86400,
                    feeTokenAddr,
                    sentCollateral
                )
            )
                .to.emit(socialLending, "LoanRequested")
                .withArgs(0, borrower.address, loanAmount, 500, 30 * 86400, feeTokenAddr, expectedReceived);

            const loan = await socialLending.loans(0);
            expect(loan.collateralAmount).to.equal(expectedReceived);
            expect(await socialLending.lockedCollateral(feeTokenAddr)).to.equal(expectedReceived);
            expect(await feeToken.balanceOf(await socialLending.getAddress())).to.equal(expectedReceived);

            // Cancel loan and verify lockedCollateral and contract balance both return to 0
            await socialLending.connect(borrower).cancelLoanRequest(0);
            expect(await socialLending.lockedCollateral(feeTokenAddr)).to.equal(0);
            expect(await feeToken.balanceOf(await socialLending.getAddress())).to.equal(0);
        });

        it("should keep lockedCollateral consistent through fund and full repay", async function () {
            const loanAmount = ethers.parseEther("1");
            const sentCollateral = ethers.parseEther("2");
            const expectedReceived = ethers.parseEther("1.9");

            await socialLending.connect(borrower).requestLoan(
                loanAmount,
                500,
                30 * 86400,
                feeTokenAddr,
                sentCollateral
            );
            await socialLending.connect(lender).fundLoan(0, { value: loanAmount });
            const loan = await socialLending.loans(0);
            await socialLending.connect(borrower).repayLoan(0, { value: loan.remainingRepaymentAmount });

            expect(await socialLending.lockedCollateral(feeTokenAddr)).to.equal(0);
            expect(await feeToken.balanceOf(await socialLending.getAddress())).to.equal(0);
            expect(loan.collateralAmount).to.equal(expectedReceived);
        });

        it("should revert with InsufficientCollateralValue when post-fee amount is below requirement", async function () {
            const loanAmount = ethers.parseEther("1");
            // 1.55 tokens sent => 5% fee => 1.4725 tokens received (< 1.5 required)
            const sentCollateral = ethers.parseEther("1.55");

            await expect(
                socialLending.connect(borrower).requestLoan(
                    loanAmount,
                    500,
                    30 * 86400,
                    feeTokenAddr,
                    sentCollateral
                )
            ).to.be.revertedWithCustomError(socialLending, "InsufficientCollateralValue");
        });

        it("should revert with InvalidCollateral when 100% fee results in 0 received tokens", async function () {
            const FeeTokenFactory = await ethers.getContractFactory("MockFeeOnTransferERC20");
            const fullFeeToken = await FeeTokenFactory.deploy("Full Fee", "FF", 10000, owner.address);
            const fullFeeAddr = await fullFeeToken.getAddress();

            await socialLending.setCollateralTokenStatus(fullFeeAddr, true);
            await socialLending.setCollateralTokenDecimals(fullFeeAddr, 18);
            await socialLending.setPriceFeed(fullFeeAddr, await mockPriceFeed.getAddress());

            await fullFeeToken.mint(borrower.address, ethers.parseEther("10"));
            await fullFeeToken.connect(borrower).approve(await socialLending.getAddress(), ethers.parseEther("10"));

            await expect(
                socialLending.connect(borrower).requestLoan(
                    ethers.parseEther("1"),
                    500,
                    30 * 86400,
                    fullFeeAddr,
                    ethers.parseEther("2")
                )
            ).to.be.revertedWithCustomError(socialLending, "InvalidCollateral");
        });
    });
});
