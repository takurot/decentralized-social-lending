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

    describe("Collateral Valuation, Decimals & Oracle Safety (Issue #9)", function () {
        it("should require collateral covering principal + interest so initial ratio >= collateralRatio", async function () {
            // 1 Token = 1 ETH
            await mockPriceFeed.setLatestPrice(ethers.parseUnits("1", 8));
            const loanAmount = ethers.parseEther("1");
            const interestRate = 2000; // 20%
            const duration = 365 * 86400; // 1 year => repaymentAmount = 1.2 ETH
            // Required at 150% of 1.2 ETH = 1.8 ETH.
            // 1.5 ETH (150% of principal only) should revert!
            await expect(
                socialLending.connect(borrower).requestLoan(
                    loanAmount,
                    interestRate,
                    duration,
                    await mockToken.getAddress(),
                    ethers.parseEther("1.5")
                )
            ).to.be.revertedWithCustomError(socialLending, "InsufficientCollateralValue");

            // Exact 1.8 ETH collateral should succeed and have getCollateralizationRatio >= 15000
            await socialLending.connect(borrower).requestLoan(
                loanAmount,
                interestRate,
                duration,
                await mockToken.getAddress(),
                ethers.parseEther("1.8")
            );
            await socialLending.connect(lender).fundLoan(0, { value: loanAmount });
            expect(await socialLending.getCollateralizationRatio(0)).to.be.gte(15000n);
        });

        it("should value 6-decimal, 8-decimal, and 0-decimal tokens accurately", async function () {
            const MockERC20Factory = await ethers.getContractFactory("MockERC20");
            const token6 = await MockERC20Factory.deploy("USDC", "USDC", 6);
            const token8 = await MockERC20Factory.deploy("WBTC", "WBTC", 8);
            const token0 = await MockERC20Factory.deploy("ZERO", "ZERO", 0);

            const feedAddr = await mockPriceFeed.getAddress();
            await mockPriceFeed.setLatestPrice(ethers.parseUnits("2", 8)); // 1 token = 2 ETH

            for (const [tok, dec, amt] of [
                [token6, 6, ethers.parseUnits("1", 6)],
                [token8, 8, ethers.parseUnits("1", 8)],
                [token0, 0, 1n],
            ]) {
                const addr = await tok.getAddress();
                await socialLending.setCollateralTokenStatus(addr, true);
                await socialLending.setPriceFeed(addr, feedAddr);
                expect(await socialLending.collateralTokenDecimals(addr)).to.equal(dec);
                expect(await socialLending.getCollateralValueInETH(addr, amt)).to.equal(ethers.parseEther("2"));
            }
        });

        it("should revert with TokenDecimalsNotSet if token has no decimals() and decimals were not explicitly set", async function () {
            const nonMetadataToken = lender.address; // EOA has no decimals()
            await socialLending.setCollateralTokenStatus(nonMetadataToken, true);
            await socialLending.setPriceFeed(nonMetadataToken, await mockPriceFeed.getAddress());

            await expect(
                socialLending.getCollateralValueInETH(nonMetadataToken, 100)
            ).to.be.revertedWithCustomError(socialLending, "TokenDecimalsNotSet");
        });

        it("should revert with InvalidPriceData when updatedAt is in the future", async function () {
            const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
            await mockPriceFeed.setPriceData(
                ethers.parseUnits("2000", 8),
                1n,
                now,
                now + 3600n,
                1n
            );

            await expect(
                socialLending.getCollateralValueInETH(await mockToken.getAddress(), ethers.parseEther("1"))
            ).to.be.revertedWithCustomError(socialLending, "InvalidPriceData");
        });
    });

    describe("Loan Offer Repayment-Denominator Collateral Check (Issue #31)", function () {
        const ONE_YEAR = 365 * 86400;

        beforeEach(async function () {
            // Set price: 1 MOCK = 1 ETH for exact 1:1 collateral math
            await mockPriceFeed.setLatestPrice(ethers.parseUnits("1", 8));
            await socialLending.connect(lender).createLoanOffer(
                2000, // 20% max APR
                86400, // minDuration: 1 day
                ONE_YEAR, // maxDuration: 365 days
                await mockToken.getAddress(), // requiredCollateralToken
                15000, // minCollateralRatio: 150%
                { value: ethers.parseEther("1") }
            );
        });

        it("should revert with InsufficientCollateralValue when collateral covers only principal*ratio", async function () {
            // 1 ETH * 150% = 1.5 ETH, but repayment is 1.2 ETH so 150% of repayment = 1.8 ETH
            await expect(
                socialLending.connect(borrower).acceptLoanOffer(
                    0,
                    2000,
                    ONE_YEAR,
                    await mockToken.getAddress(),
                    ethers.parseEther("1.5")
                )
            ).to.be.revertedWithCustomError(socialLending, "InsufficientCollateralValue");
        });

        it("should succeed with exact repayment-basis collateral and maintain >= 150% ratio", async function () {
            await socialLending.connect(borrower).acceptLoanOffer(
                0,
                2000,
                ONE_YEAR,
                await mockToken.getAddress(),
                ethers.parseEther("1.8")
            );

            const ratio = await socialLending.getCollateralizationRatio(0);
            expect(ratio).to.be.gte(15000n);
        });

        it("should prevent immediate day-one liquidation on an accepted offer", async function () {
            await socialLending.connect(borrower).acceptLoanOffer(
                0,
                2000,
                ONE_YEAR,
                await mockToken.getAddress(),
                ethers.parseEther("1.8")
            );

            await expect(
                socialLending.connect(lender).liquidate(0)
            ).to.be.revertedWithCustomError(socialLending, "CollateralSufficient");
        });
    });
});
