const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Collateral Liquidation (PR-06)", function () {
    let socialLending;
    let owner, borrower, lender, liquidator, mockToken, mockPriceFeed;
    const BASIS_POINTS = 10000n;
    const LOAN_AMOUNT = ethers.parseEther("1");
    const INTEREST_RATE = 500; // 5%
    const DURATION = 30 * 24 * 60 * 60;
    const COLLATERAL_AMOUNT = ethers.parseEther("2"); // Initially 2 tokens @ 1 ETH = 2 ETH (~200%)

    beforeEach(async function () {
        [owner, borrower, lender, liquidator] = await ethers.getSigners();

        const MockToken = await ethers.getContractFactory("MockERC20");
        mockToken = await MockToken.deploy("Mock", "MOCK", 18);

        const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed");
        mockPriceFeed = await MockPriceFeed.deploy();
        await mockPriceFeed.setLatestPrice(ethers.parseUnits("1", 8)); // 1 token = 1 ETH

        const SocialLending = await ethers.getContractFactory("SocialLendingWithCollateral");
        socialLending = await SocialLending.deploy(owner.address);

        await socialLending.setCollateralTokenStatus(await mockToken.getAddress(), true);
        await socialLending.setCollateralTokenDecimals(await mockToken.getAddress(), 18);
        await socialLending.setPriceFeed(await mockToken.getAddress(), await mockPriceFeed.getAddress());

        await mockToken.mint(borrower.address, ethers.parseEther("100"));
        await mockToken.connect(borrower).approve(await socialLending.getAddress(), ethers.parseEther("100"));

        await socialLending.connect(borrower).requestLoan(
            LOAN_AMOUNT,
            INTEREST_RATE,
            DURATION,
            await mockToken.getAddress(),
            COLLATERAL_AMOUNT
        );
        await socialLending.connect(lender).fundLoan(0, { value: LOAN_AMOUNT });
    });

    it("should revert liquidation when collateralization ratio >= liquidationThreshold", async function () {
        const loan = await socialLending.loans(0);
        await expect(
            socialLending.connect(liquidator).liquidate(0, { value: loan.remainingRepaymentAmount })
        ).to.be.revertedWithCustomError(socialLending, "CollateralSufficient");
    });

    it("should liquidate undercollateralized loan, pay bonus to liquidator, return surplus to borrower, and preserve invariants", async function () {
        // Price drops to 0.58 ETH => collateralValue = 2 * 0.58 = 1.16 ETH (< 120% of ~1.0041 ETH)
        await mockPriceFeed.setLatestPrice(ethers.parseUnits("0.58", 8));

        const loanBefore = await socialLending.loans(0);
        const debtRepaid = loanBefore.remainingRepaymentAmount;
        const excessETH = ethers.parseEther("0.1");
        const collateralValue = await socialLending.getCollateralValueInETH(
            await mockToken.getAddress(),
            COLLATERAL_AMOUNT
        );
        const bonus = await socialLending.liquidationBonus(); // 500 = 5%
        const seizeValue = (debtRepaid * (BASIS_POINTS + bonus)) / BASIS_POINTS;
        const expectedSeize = (COLLATERAL_AMOUNT * seizeValue + collateralValue - 1n) / collateralValue;
        const expectedSurplus = COLLATERAL_AMOUNT - expectedSeize;

        const lenderBalanceBefore = await ethers.provider.getBalance(lender.address);

        await expect(
            socialLending.connect(liquidator).liquidate(0, { value: debtRepaid + excessETH })
        )
            .to.emit(socialLending, "LoanLiquidated")
            .withArgs(0, liquidator.address, expectedSeize, expectedSurplus, debtRepaid);

        const lenderBalanceAfter = await ethers.provider.getBalance(lender.address);
        expect(lenderBalanceAfter - lenderBalanceBefore).to.equal(debtRepaid);

        // Accounting invariants
        expect(expectedSeize + expectedSurplus).to.equal(COLLATERAL_AMOUNT);
        expect(await mockToken.balanceOf(liquidator.address)).to.equal(expectedSeize);
        expect(await mockToken.balanceOf(borrower.address)).to.equal(
            ethers.parseEther("100") - COLLATERAL_AMOUNT + expectedSurplus
        );
        expect(await socialLending.lockedCollateral(await mockToken.getAddress())).to.equal(0);

        const loanAfter = await socialLending.loans(0);
        expect(loanAfter.state).to.equal(5); // LoanState.Liquidated
        expect(loanAfter.remainingRepaymentAmount).to.equal(0);
        expect(await socialLending.borrowerActiveLoans(borrower.address)).to.equal(0);
        expect(await socialLending.lenderActiveLoans(lender.address)).to.equal(0);

        const stats = await socialLending.getStats();
        expect(stats.activeLoans).to.equal(0);
        expect(stats.liquidatedLoans).to.equal(1);
        expect(stats.repaidLoans).to.equal(0);
        expect(stats.defaultedLoans).to.equal(0);

        // Contract should not retain excessETH
        expect(await ethers.provider.getBalance(await socialLending.getAddress())).to.equal(0);
    });

    it("should cap seized collateral at full collateralAmount when deeply underwater", async function () {
        // Price drops to 0.3 ETH => collateralValue = 0.6 ETH < debt (~1.0041 ETH)
        await mockPriceFeed.setLatestPrice(ethers.parseUnits("0.3", 8));
        const loan = await socialLending.loans(0);

        await expect(
            socialLending.connect(liquidator).liquidate(0, { value: loan.remainingRepaymentAmount })
        )
            .to.emit(socialLending, "LoanLiquidated")
            .withArgs(0, liquidator.address, COLLATERAL_AMOUNT, 0, loan.remainingRepaymentAmount);

        expect(await mockToken.balanceOf(liquidator.address)).to.equal(COLLATERAL_AMOUNT);
        expect(await socialLending.lockedCollateral(await mockToken.getAddress())).to.equal(0);
    });

    it("should revert liquidate if loan is not Funded or ETH sent is insufficient", async function () {
        await mockPriceFeed.setLatestPrice(ethers.parseUnits("0.55", 8));
        const loan = await socialLending.loans(0);

        await expect(
            socialLending.connect(liquidator).liquidate(0, { value: loan.remainingRepaymentAmount - 1n })
        ).to.be.revertedWithCustomError(socialLending, "InvalidAmount");

        // Liquidate once
        await socialLending.connect(liquidator).liquidate(0, { value: loan.remainingRepaymentAmount });

        // Cannot liquidate again
        await expect(
            socialLending.connect(liquidator).liquidate(0, { value: loan.remainingRepaymentAmount })
        ).to.be.revertedWithCustomError(socialLending, "InvalidLoanState");
    });

    it("should allow owner to setLiquidationThreshold within valid bounds", async function () {
        await expect(socialLending.connect(liquidator).setLiquidationThreshold(13000))
            .to.be.revertedWith("Ownable: caller is not the owner");

        await expect(socialLending.connect(owner).setLiquidationThreshold(10500))
            .to.be.revertedWithCustomError(socialLending, "InvalidParameter");

        await expect(socialLending.connect(owner).setLiquidationThreshold(16000))
            .to.be.revertedWithCustomError(socialLending, "InvalidParameter");

        await expect(socialLending.connect(owner).setLiquidationThreshold(13000))
            .to.emit(socialLending, "LiquidationThresholdUpdated")
            .withArgs(13000);
        expect(await socialLending.liquidationThreshold()).to.equal(13000);
    });
});
