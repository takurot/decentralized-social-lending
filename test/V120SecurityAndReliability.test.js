const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { wrapWithTimelock } = require("./helpers/timelock");

describe("Milestone v1.2.0 Security & Reliability Hardening (Issues #48, #49, #50, #51, #53, #54)", function () {
    let lending, mockToken, mockPriceFeed;
    let owner, borrower, lender, liquidator, other;

    beforeEach(async function () {
        [owner, borrower, lender, liquidator, other] = await ethers.getSigners();

        const MockERC20 = await ethers.getContractFactory("MockERC20");
        mockToken = await MockERC20.deploy("Mock Token", "MTK", 18);
        await mockToken.waitForDeployment();

        const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed");
        mockPriceFeed = await MockPriceFeed.deploy();
        await mockPriceFeed.waitForDeployment();
        await mockPriceFeed.setLatestPrice(ethers.parseUnits("2", 8)); // 1 MTK = 2 ETH

        const Lending = await ethers.getContractFactory("SocialLendingWithCollateral");
        const deployed = await Lending.deploy(owner.address);
        await deployed.waitForDeployment();
        lending = wrapWithTimelock(deployed, [mockPriceFeed]);

        const tokenAddr = await mockToken.getAddress();
        await lending.setCollateralTokenStatus(tokenAddr, true);
        await lending.setCollateralTokenDecimals(tokenAddr, 18);
        await lending.setPriceFeed(tokenAddr, await mockPriceFeed.getAddress());

        await mockToken.mint(borrower.address, ethers.parseEther("1000"));
        await mockToken.connect(borrower).approve(await lending.getAddress(), ethers.MaxUint256);
    });

    describe("Issue #49: Prevent setCollateralTokenDecimals while collateral is locked", function () {
        it("should revert setCollateralTokenDecimals with CollateralLocked while Requested or Funded loan exists, and succeed once unlocked", async function () {
            const tokenAddr = await mockToken.getAddress();

            // Lock collateral in Requested state
            await lending
                .connect(borrower)
                .requestLoan(ethers.parseEther("1"), 500, 7 * 86400, tokenAddr, ethers.parseEther("1"));

            await expect(lending.setCollateralTokenDecimals(tokenAddr, 6))
                .to.be.revertedWithCustomError(lending, "CollateralLocked");

            // Fund loan -> still locked in Funded state
            await lending.connect(lender).fundLoan(0, { value: ethers.parseEther("1") });
            await expect(lending.setCollateralTokenDecimals(tokenAddr, 6))
                .to.be.revertedWithCustomError(lending, "CollateralLocked");

            // Repay in full -> lockedCollateral returns to 0 -> setCollateralTokenDecimals succeeds
            const loan = await lending.loans(0);
            await lending.connect(borrower).repayLoan(0, { value: loan.remainingRepaymentAmount });
            expect(await lending.lockedCollateral(tokenAddr)).to.equal(0n);

            await expect(lending.setCollateralTokenDecimals(tokenAddr, 6))
                .to.emit(lending, "CollateralTokenDecimalsUpdated")
                .withArgs(tokenAddr, 6);
        });
    });

    describe("Issue #54: Allow repayLoan while paused to prevent pause-induced default/liquidation deadlock", function () {
        it("should allow partial and full repayLoan while paused and prevent post-unpause default", async function () {
            const tokenAddr = await mockToken.getAddress();
            const duration = 7 * 86400;
            await lending
                .connect(borrower)
                .requestLoan(ethers.parseEther("1"), 500, duration, tokenAddr, ethers.parseEther("1"));
            await lending.connect(lender).fundLoan(0, { value: ethers.parseEther("1") });

            await lending.pause();

            // Partial repayment while paused
            const loanBefore = await lending.loans(0);
            const partialPay = ethers.parseEther("0.4");
            await expect(lending.connect(borrower).repayLoan(0, { value: partialPay }))
                .to.emit(lending, "LoanPartiallyRepaid")
                .withArgs(0, borrower.address, partialPay, loanBefore.remainingRepaymentAmount - partialPay);

            // Advance past maturity + gracePeriod while still paused
            await time.increase(duration + 4 * 86400);

            // Borrower can still repay remaining debt in full while paused before unpause
            const loanMid = await lending.loans(0);
            await expect(lending.connect(borrower).repayLoan(0, { value: loanMid.remainingRepaymentAmount }))
                .to.emit(lending, "LoanRepaid")
                .withArgs(0, borrower.address, lender.address, loanMid.remainingRepaymentAmount);

            await lending.unpause();

            // Default declaration after unpause must fail because loan was repaid during pause
            await expect(lending.connect(lender).declareDefault(0))
                .to.be.revertedWithCustomError(lending, "InvalidLoanState");
        });
    });

    describe("Issue #53: withdrawETHTo for non-payable contracts, reject plain receive(), and rescueTokens overflow guard", function () {
        it("should allow a permanently non-payable contract to withdraw queued ETH to an alternate recipient via withdrawETHTo", async function () {
            const MockRevertingReceiver = await ethers.getContractFactory("MockRevertingReceiver");
            const nonPayable = await MockRevertingReceiver.deploy();
            await nonPayable.waitForDeployment();
            const nonPayableAddr = await nonPayable.getAddress();

            await lending.setFeeRecipient(nonPayableAddr);

            const tokenAddr = await mockToken.getAddress();
            const loanAmount = ethers.parseEther("1");
            await lending.connect(borrower).requestLoan(loanAmount, 500, 7 * 86400, tokenAddr, ethers.parseEther("1"));
            await lending.connect(lender).fundLoan(0, { value: loanAmount });

            const expectedFee = ethers.parseEther("0.01");
            expect(await lending.pendingETHWithdrawals(nonPayableAddr)).to.equal(expectedFee);

            // Zero address recipient must revert with InvalidAddress
            const zeroData = lending.interface.encodeFunctionData("withdrawETHTo", [ethers.ZeroAddress]);
            await expect(nonPayable.callContract(await lending.getAddress(), zeroData)).to.be.revertedWith(
                "Forward call failed"
            );
            await expect(lending.connect(other).withdrawETHTo(ethers.ZeroAddress))
                .to.be.revertedWithCustomError(lending, "InvalidAddress");

            // While shouldRevert remains true, nonPayable withdraws queued ETH to `other.address`
            const otherBefore = await ethers.provider.getBalance(other.address);
            const withdrawToData = lending.interface.encodeFunctionData("withdrawETHTo", [other.address]);
            await nonPayable.callContract(await lending.getAddress(), withdrawToData);

            const otherAfter = await ethers.provider.getBalance(other.address);
            expect(otherAfter - otherBefore).to.equal(expectedFee);
            expect(await lending.pendingETHWithdrawals(nonPayableAddr)).to.equal(0n);
            expect(await lending.lockedETH()).to.equal(0n);
        });

        it("should reject accidental plain ETH transfers without calldata", async function () {
            await expect(
                owner.sendTransaction({
                    to: await lending.getAddress(),
                    value: ethers.parseEther("0.1"),
                })
            ).to.be.reverted;
        });

        it("should revert rescueTokens with InsufficientUnlockedCollateral (not Panic) on MaxUint256 when collateral is locked", async function () {
            const tokenAddr = await mockToken.getAddress();
            await lending
                .connect(borrower)
                .requestLoan(ethers.parseEther("1"), 500, 7 * 86400, tokenAddr, ethers.parseEther("1"));

            await expect(lending.rescueTokens(tokenAddr, ethers.MaxUint256, owner.address))
                .to.be.revertedWithCustomError(lending, "InsufficientUnlockedCollateral");
        });
    });

    describe("Issue #51: Fix seizeAmount rounding to zero, interest double-truncation, and platformFee slippage", function () {
        it("should round seizeAmount up to at least 1 unit on 0-decimal collateral default and liquidation instead of 0", async function () {
            const MockERC20 = await ethers.getContractFactory("MockERC20");
            const token0 = await MockERC20.deploy("ZeroDec", "Z0", 0);
            await token0.waitForDeployment();
            const token0Addr = await token0.getAddress();

            await lending.setCollateralTokenStatus(token0Addr, true);
            await lending.setPriceFeed(token0Addr, await mockPriceFeed.getAddress()); // 1 unit = 2 ETH

            await token0.mint(borrower.address, 10n);
            await token0.connect(borrower).approve(await lending.getAddress(), 10n);

            // Request 1 ETH loan with 1 unit of 0-decimal collateral worth 2 ETH (200% ratio)
            await lending.connect(borrower).requestLoan(ethers.parseEther("1"), 500, 7 * 86400, token0Addr, 1n);
            await lending.connect(lender).fundLoan(0, { value: ethers.parseEther("1") });

            // Advance past duration + gracePeriod and declare default
            // seizeValue (~1.051 ETH) < collateralValue (2 ETH), but with 1 unit of 0-decimal token, round-up must seize 1 unit!
            await time.increase(11 * 86400);
            await mockPriceFeed.setLatestPrice(ethers.parseUnits("2", 8));

            await expect(lending.connect(lender).declareDefault(0))
                .to.emit(lending, "DefaultDeclared")
                .withArgs(0, lender.address, 1n, 0n);
            expect(await token0.balanceOf(lender.address)).to.equal(1n);
        });

        it("should compute single-step Math.mulDiv interest without intermediate annualInterest truncation", async function () {
            const tokenAddr = await mockToken.getAddress();
            // amount = 19,000 wei, interestRate = 1 bp, duration = 219 days (0.6 * 365 days)
            // 2-step truncates annualInterest = floor(19000 / 10000) = 1 -> floor(1 * 0.6) = 0
            // 1-step computes floor(19000 * 1 * 219 days / (10000 * 365 days)) = floor(1.14) = 1 wei
            const amount = 19000n;
            const duration = 219 * 86400;
            await lending.connect(borrower).requestLoan(amount, 1, duration, tokenAddr, ethers.parseEther("1"));

            const loan = await lending.loans(0);
            expect(loan.repaymentAmount).to.equal(amount + 1n);
        });

        it("should snapshot platformFee at requestLoan so a subsequent fee increase does not reduce borrower proceeds at fundLoan", async function () {
            const tokenAddr = await mockToken.getAddress();
            const loanAmount = ethers.parseEther("1");

            // Request loan while platformFee is 100 bp (1%)
            await lending.connect(borrower).requestLoan(loanAmount, 500, 7 * 86400, tokenAddr, ethers.parseEther("1"));

            // Owner raises platformFee to 500 bp (5%) before funding
            await lending.setPlatformFee(500);

            const borrowerBefore = await ethers.provider.getBalance(borrower.address);
            await lending.connect(lender).fundLoan(0, { value: loanAmount });
            const borrowerAfter = await ethers.provider.getBalance(borrower.address);

            // Borrower must receive 99% (1% snapshotted fee), not 95%
            expect(borrowerAfter - borrowerBefore).to.equal(ethers.parseEther("0.99"));
        });
    });

    describe("Issue #48: Re-validate token allowlist and live collateralization in fundLoan and enforce request expiration", function () {
        it("should revert fundLoan with TokenNotAllowed if collateral token is delisted after requestLoan", async function () {
            const tokenAddr = await mockToken.getAddress();
            await lending
                .connect(borrower)
                .requestLoan(ethers.parseEther("1"), 500, 7 * 86400, tokenAddr, ethers.parseEther("1"));

            await lending.setCollateralTokenStatus(tokenAddr, false);

            await expect(lending.connect(lender).fundLoan(0, { value: ethers.parseEther("1") }))
                .to.be.revertedWithCustomError(lending, "TokenNotAllowed");
        });

        it("should revert fundLoan with InsufficientCollateralValue if collateral price drops below required ratio before funding", async function () {
            const tokenAddr = await mockToken.getAddress();
            // 1 ETH loan, 1 MTK @ 2 ETH = 200% ratio at request time
            await lending
                .connect(borrower)
                .requestLoan(ethers.parseEther("1"), 500, 7 * 86400, tokenAddr, ethers.parseEther("1"));

            // Price drops from 2 ETH to 1.2 ETH (< 150% required collateral ratio)
            await mockPriceFeed.setLatestPrice(ethers.parseUnits("1.2", 8));

            await expect(lending.connect(lender).fundLoan(0, { value: ethers.parseEther("1") }))
                .to.be.revertedWithCustomError(lending, "InsufficientCollateralValue");
        });

        it("should revert fundLoan with LoanRequestExpired after LOAN_REQUEST_EXPIRATION while still allowing cancelLoanRequest", async function () {
            const tokenAddr = await mockToken.getAddress();
            await lending
                .connect(borrower)
                .requestLoan(ethers.parseEther("1"), 500, 7 * 86400, tokenAddr, ethers.parseEther("1"));

            const expiryWindow = await lending.LOAN_REQUEST_EXPIRATION();
            await time.increase(Number(expiryWindow) + 1);
            await mockPriceFeed.setLatestPrice(ethers.parseUnits("2", 8));

            await expect(lending.connect(lender).fundLoan(0, { value: ethers.parseEther("1") }))
                .to.be.revertedWithCustomError(lending, "LoanRequestExpired");

            // Borrower can still cancel and recover collateral
            await expect(lending.connect(borrower).cancelLoanRequest(0))
                .to.emit(lending, "LoanCancelled")
                .withArgs(0, borrower.address);
        });
    });

    describe("Issue #50: Per-token configurable oracle timeout, config-time timestamp validation, and default oracle-failure fallback", function () {
        it("should support per-token configurable priceFeedTimeouts (e.g., 24h heartbeat) with bounds and timelock support", async function () {
            const tokenAddr = await mockToken.getAddress();
            expect(await lending.getEffectivePriceFeedTimeout(tokenAddr)).to.equal(3600n);

            await expect(lending.setPriceFeedTimeout(ethers.ZeroAddress, 86400))
                .to.be.revertedWithCustomError(lending, "InvalidAddress");
            await expect(lending.setPriceFeedTimeout(tokenAddr, 60))
                .to.be.revertedWithCustomError(lending, "InvalidParameter");
            await expect(lending.setPriceFeedTimeout(tokenAddr, 49 * 3600))
                .to.be.revertedWithCustomError(lending, "InvalidParameter");

            await expect(lending.setPriceFeedTimeout(tokenAddr, 24 * 3600))
                .to.emit(lending, "PriceFeedTimeoutUpdated")
                .withArgs(tokenAddr, 24 * 3600);
            expect(await lending.getEffectivePriceFeedTimeout(tokenAddr)).to.equal(BigInt(24 * 3600));

            // Advance 12 hours (> default 1h, but <= 24h custom timeout): valuation still succeeds!
            await time.increase(12 * 3600);
            expect(await lending.getCollateralValueInETH(tokenAddr, ethers.parseEther("1"))).to.equal(
                ethers.parseEther("2")
            );
        });

        it("should reject stale, uninitialized, or incomplete-round price feeds at config time in setPriceFeed", async function () {
            const tokenAddr = await mockToken.getAddress();
            const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed");
            const candidateFeed = await MockPriceFeed.deploy();
            await candidateFeed.waitForDeployment();
            const feedAddr = await candidateFeed.getAddress();

            const now = await time.latest();

            // Stale updatedAt (> 1h)
            await candidateFeed.setPriceData(ethers.parseUnits("2", 8), 1, now - 7200, now - 7200, 1);
            await expect(lending.setPriceFeed(tokenAddr, feedAddr))
                .to.be.revertedWithCustomError(lending, "StaleData");

            // Incomplete round (answeredInRound < roundId)
            await candidateFeed.setPriceData(ethers.parseUnits("2", 8), 5, now, now, 4);
            await expect(lending.setPriceFeed(tokenAddr, feedAddr))
                .to.be.revertedWithCustomError(lending, "StaleData");

            // startedAt == 0
            await candidateFeed.setPriceData(ethers.parseUnits("2", 8), 1, 0, now, 1);
            await expect(lending.setPriceFeed(tokenAddr, feedAddr))
                .to.be.revertedWithCustomError(lending, "InvalidPriceData");
        });

        it("should revert default settlement on stale oracle before ORACLE_FALLBACK_DELAY and settle via full-seizure fallback after ORACLE_FALLBACK_DELAY", async function () {
            const tokenAddr = await mockToken.getAddress();
            const duration = 7 * 86400;
            await lending
                .connect(borrower)
                .requestLoan(ethers.parseEther("1"), 500, duration, tokenAddr, ethers.parseEther("1"));
            await lending.connect(lender).fundLoan(0, { value: ethers.parseEther("1") });

            const grace = Number(await lending.gracePeriod());
            const fallbackDelay = Number(await lending.ORACLE_FALLBACK_DELAY());

            // Advance just past duration + gracePeriod (oracle is now >10 days stale, before fallback delay)
            await time.increase(duration + grace + 10);
            await expect(lending.connect(lender).declareDefault(0))
                .to.be.revertedWithCustomError(lending, "StaleData");

            // Advance past ORACLE_FALLBACK_DELAY without any oracle update (simulating dead/deprecated feed)
            await time.increase(fallbackDelay);
            await expect(lending.connect(lender).declareDefault(0))
                .to.emit(lending, "DefaultDeclared")
                .withArgs(0, lender.address, ethers.parseEther("1"), 0n);

            const loan = await lending.loans(0);
            expect(loan.state).to.equal(3n); // LoanState.Defaulted
            expect(await lending.lockedCollateral(tokenAddr)).to.equal(0n);
            expect(await mockToken.balanceOf(lender.address)).to.equal(ethers.parseEther("1"));
        });
    });
});
