const { expect } = require("chai");
const { ethers } = require("hardhat");
const { wrapWithTimelock } = require("./helpers/timelock");

describe("Grace Period (PR-06)", function () {
    let socialLending;
    let owner, borrower, lender, other, mockToken, mockPriceFeed;
    const LOAN_AMOUNT = ethers.parseEther("1");
    const INTEREST_RATE = 500;
    const DURATION = 30 * 24 * 60 * 60;
    const COLLATERAL_AMOUNT = ethers.parseEther("2");

    beforeEach(async function () {
        [owner, borrower, lender, other] = await ethers.getSigners();

        const MockToken = await ethers.getContractFactory("MockERC20");
        mockToken = await MockToken.deploy("Mock", "MOCK", 18);

        const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed");
        mockPriceFeed = await MockPriceFeed.deploy();
        await mockPriceFeed.setLatestPrice(ethers.parseUnits("1", 8));

        const SocialLending = await ethers.getContractFactory("SocialLendingWithCollateral");
        socialLending = wrapWithTimelock(await SocialLending.deploy(owner.address), [mockPriceFeed]);

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

    it("should reject declareDefault and checkAndDeclareDefault during grace period", async function () {
        // Advance just past duration, still within 3-day grace period
        await ethers.provider.send("evm_increaseTime", [DURATION + 2 * 86400]);
        await ethers.provider.send("evm_mine");

        await expect(socialLending.connect(lender).declareDefault(0))
            .to.be.revertedWithCustomError(socialLending, "LoanNotExpired");
        await expect(socialLending.connect(other).checkAndDeclareDefault(0))
            .to.be.revertedWithCustomError(socialLending, "LoanNotExpired");
    });

    it("should allow declareDefault after grace period expires", async function () {
        const grace = await socialLending.gracePeriod();
        await ethers.provider.send("evm_increaseTime", [DURATION + Number(grace) + 1]);
        await ethers.provider.send("evm_mine");
        await mockPriceFeed.setLatestPrice(ethers.parseUnits("1", 8));

        await expect(socialLending.connect(lender).declareDefault(0))
            .to.emit(socialLending, "DefaultDeclared");

        const loan = await socialLending.loans(0);
        expect(loan.state).to.equal(3); // Defaulted
    });

    it("should allow owner to update gracePeriod within 30 days and reject > 30 days or non-owner", async function () {
        const maxGrace = 30 * 86400;
        await expect(socialLending.connect(other).setGracePeriod(86400))
            .to.be.revertedWith("Ownable: caller is not the owner");

        await expect(socialLending.connect(owner).setGracePeriod(maxGrace + 1))
            .to.be.revertedWithCustomError(socialLending, "InvalidParameter");

        await expect(socialLending.connect(owner).setGracePeriod(7 * 86400))
            .to.emit(socialLending, "GracePeriodUpdated")
            .withArgs(7 * 86400);
        expect(await socialLending.gracePeriod()).to.equal(7 * 86400);
    });

    it("should return surplus collateral to borrower on over-collateralized declareDefault", async function () {
        const grace = await socialLending.gracePeriod();
        await ethers.provider.send("evm_increaseTime", [DURATION + Number(grace) + 1]);
        await ethers.provider.send("evm_mine");
        await mockPriceFeed.setLatestPrice(ethers.parseUnits("1", 8));

        const loanBefore = await socialLending.loans(0);
        const borrowerBefore = await mockToken.balanceOf(borrower.address);
        const lenderBefore = await mockToken.balanceOf(lender.address);

        const tx = await socialLending.connect(lender).declareDefault(0);
        const receipt = await tx.wait();
        const ev = receipt.logs
            .map((l) => { try { return socialLending.interface.parseLog(l); } catch { return null; } })
            .find((p) => p && p.name === "DefaultDeclared");

        expect(ev.args.seizedCollateral + ev.args.surplusCollateral).to.equal(loanBefore.collateralAmount);
        expect(ev.args.surplusCollateral).to.be.gt(0n);

        const borrowerAfter = await mockToken.balanceOf(borrower.address);
        const lenderAfter = await mockToken.balanceOf(lender.address);
        expect(lenderAfter - lenderBefore).to.equal(ev.args.seizedCollateral);
        expect(borrowerAfter - borrowerBefore).to.equal(ev.args.surplusCollateral);
        expect(lenderAfter - lenderBefore).to.be.gte(loanBefore.remainingRepaymentAmount);
    });

    it("should return surplus collateral to borrower on over-collateralized checkAndDeclareDefault", async function () {
        const grace = await socialLending.gracePeriod();
        await ethers.provider.send("evm_increaseTime", [DURATION + Number(grace) + 1]);
        await ethers.provider.send("evm_mine");
        await mockPriceFeed.setLatestPrice(ethers.parseUnits("1", 8));

        const loanBefore = await socialLending.loans(0);
        const borrowerBefore = await mockToken.balanceOf(borrower.address);
        const lenderBefore = await mockToken.balanceOf(lender.address);

        const tx = await socialLending.connect(other).checkAndDeclareDefault(0);
        const receipt = await tx.wait();
        const ev = receipt.logs
            .map((l) => { try { return socialLending.interface.parseLog(l); } catch { return null; } })
            .find((p) => p && p.name === "DefaultDeclared");

        expect(ev.args.seizedCollateral + ev.args.surplusCollateral).to.equal(loanBefore.collateralAmount);
        expect(ev.args.surplusCollateral).to.be.gt(0n);
        expect((await mockToken.balanceOf(lender.address)) - lenderBefore).to.equal(ev.args.seizedCollateral);
        expect((await mockToken.balanceOf(borrower.address)) - borrowerBefore).to.equal(ev.args.surplusCollateral);
    });

    it("should seize full collateral with zero surplus when under-collateralized on default", async function () {
        const grace = await socialLending.gracePeriod();
        await ethers.provider.send("evm_increaseTime", [DURATION + Number(grace) + 1]);
        await ethers.provider.send("evm_mine");
        // Drop price so 2 MOCK = 0.8 ETH < ~1.05 ETH debt+bonus
        await mockPriceFeed.setLatestPrice(ethers.parseUnits("0.4", 8));

        const borrowerBefore = await mockToken.balanceOf(borrower.address);
        const lenderBefore = await mockToken.balanceOf(lender.address);

        await expect(socialLending.connect(lender).declareDefault(0))
            .to.emit(socialLending, "DefaultDeclared")
            .withArgs(0, lender.address, COLLATERAL_AMOUNT, 0n);

        expect((await mockToken.balanceOf(lender.address)) - lenderBefore).to.equal(COLLATERAL_AMOUNT);
        expect(await mockToken.balanceOf(borrower.address)).to.equal(borrowerBefore);
    });
});
