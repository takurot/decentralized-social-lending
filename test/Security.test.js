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

    describe("Pull-Payment ETH Fallback & Rescue Protection (Issue #10)", function () {
        let revertingReceiver;

        beforeEach(async function () {
            const RevertingFactory = await ethers.getContractFactory("MockRevertingReceiver");
            revertingReceiver = await RevertingFactory.deploy();
        });

        it("should queue repayment ETH instead of reverting when lender rejects ETH", async function () {
            const loanAmount = ethers.parseEther("1");
            const collateralAmount = ethers.parseEther("0.002");
            await socialLending.connect(borrower).requestLoan(
                loanAmount,
                500,
                30 * 86400,
                await mockToken.getAddress(),
                collateralAmount
            );

            // RevertingReceiver funds the loan
            const fundData = socialLending.interface.encodeFunctionData("fundLoan", [0]);
            await revertingReceiver.callContract(await socialLending.getAddress(), fundData, { value: loanAmount });

            const loan = await socialLending.loans(0);
            const receiverAddr = await revertingReceiver.getAddress();

            // Borrower repays in full; lender reverts on ETH receive, so ETH is queued
            await expect(
                socialLending.connect(borrower).repayLoan(0, { value: loan.remainingRepaymentAmount })
            )
                .to.emit(socialLending, "ETHWithdrawalQueued")
                .withArgs(receiverAddr, loan.remainingRepaymentAmount);

            const updatedLoan = await socialLending.loans(0);
            expect(updatedLoan.state).to.equal(2); // Repaid
            expect(await socialLending.pendingETHWithdrawals(receiverAddr)).to.equal(loan.remainingRepaymentAmount);
            expect(await socialLending.lockedETH()).to.equal(loan.remainingRepaymentAmount);

            // rescueETH must not withdraw lockedETH
            await expect(
                socialLending.connect(owner).rescueETH(1n, owner.address)
            ).to.be.revertedWithCustomError(socialLending, "InsufficientUnlockedETH");

            // Lender disables revert and withdraws queued ETH even while paused
            await revertingReceiver.setShouldRevert(false);
            await socialLending.connect(owner).pause();
            const withdrawData = socialLending.interface.encodeFunctionData("withdrawETH", []);
            await revertingReceiver.callContract(await socialLending.getAddress(), withdrawData);

            expect(await socialLending.pendingETHWithdrawals(receiverAddr)).to.equal(0);
            expect(await socialLending.lockedETH()).to.equal(0);
            expect(await ethers.provider.getBalance(receiverAddr)).to.equal(loan.remainingRepaymentAmount);
        });

        it("should not allow a gas-burning lender to DoS repayLoan", async function () {
            const loanAmount = ethers.parseEther("1");
            await socialLending.connect(borrower).requestLoan(
                loanAmount,
                500,
                30 * 86400,
                await mockToken.getAddress(),
                ethers.parseEther("0.002")
            );
            const fundData = socialLending.interface.encodeFunctionData("fundLoan", [0]);
            await revertingReceiver.callContract(await socialLending.getAddress(), fundData, { value: loanAmount });

            await revertingReceiver.setBurnGas(true);
            const loan = await socialLending.loans(0);
            await expect(
                socialLending.connect(borrower).repayLoan(0, { value: loan.remainingRepaymentAmount })
            ).to.not.be.reverted;
            expect(await socialLending.pendingETHWithdrawals(await revertingReceiver.getAddress())).to.equal(
                loan.remainingRepaymentAmount
            );
        });

        it("should queue fee ETH when feeRecipient reverts on receive", async function () {
            const receiverAddr = await revertingReceiver.getAddress();
            await socialLending.connect(owner).setFeeRecipient(receiverAddr);

            const loanAmount = ethers.parseEther("1");
            await socialLending.connect(borrower).requestLoan(
                loanAmount,
                500,
                30 * 86400,
                await mockToken.getAddress(),
                ethers.parseEther("0.002")
            );

            const expectedFee = (loanAmount * 100n) / 10000n;
            await expect(socialLending.connect(lender).fundLoan(0, { value: loanAmount }))
                .to.emit(socialLending, "ETHWithdrawalQueued")
                .withArgs(receiverAddr, expectedFee);

            expect(await socialLending.pendingETHWithdrawals(receiverAddr)).to.equal(expectedFee);
            expect(await socialLending.lockedETH()).to.equal(expectedFee);
        });

        it("should revert withdrawETH when pending balance is 0", async function () {
            await expect(socialLending.connect(lender).withdrawETH())
                .to.be.revertedWithCustomError(socialLending, "InvalidAmount");
        });

        it("should emit TokensRescued and ETHRescued events", async function () {
            const extraTokens = ethers.parseEther("1");
            await mockToken.mint(await socialLending.getAddress(), extraTokens);
            await expect(
                socialLending.connect(owner).rescueTokens(await mockToken.getAddress(), extraTokens, owner.address)
            )
                .to.emit(socialLending, "TokensRescued")
                .withArgs(await mockToken.getAddress(), extraTokens, owner.address);

            const extraETH = ethers.parseEther("0.5");
            await owner.sendTransaction({ to: await socialLending.getAddress(), value: extraETH });
            await expect(
                socialLending.connect(owner).rescueETH(extraETH, owner.address)
            )
                .to.emit(socialLending, "ETHRescued")
                .withArgs(extraETH, owner.address);
        });
    });
});
