const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Pause/Unpause Functionality", function () {
    let socialLending;
    let owner, borrower, lender, otherUser, mockToken, mockPriceFeed;
    const LOAN_AMOUNT = ethers.parseEther("1");
    const INTEREST_RATE = 500; // 5%
    const DURATION = 30 * 24 * 60 * 60; // 30 days
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

        // Mint tokens to borrower
        await mockToken.mint(borrower.address, ethers.parseEther("1000"));
        await mockToken.connect(borrower).approve(await socialLending.getAddress(), ethers.parseEther("1000"));
    });

    describe("Access Control", function () {
        it("should allow owner to pause and unpause", async function () {
            await expect(socialLending.pause())
                .to.emit(socialLending, "Paused")
                .withArgs(owner.address);

            expect(await socialLending.paused()).to.be.true;

            await expect(socialLending.unpause())
                .to.emit(socialLending, "Unpaused")
                .withArgs(owner.address);

            expect(await socialLending.paused()).to.be.false;
        });

        it("should revert if non-owner tries to pause", async function () {
            await expect(socialLending.connect(otherUser).pause())
                .to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("should revert if non-owner tries to unpause", async function () {
            await socialLending.pause();
            await expect(socialLending.connect(otherUser).unpause())
                .to.be.revertedWith("Ownable: caller is not the owner");
        });
    });

    describe("Function Restrictions when Paused", function () {
        beforeEach(async function () {
            // Create a loan before pausing for testing state transitions
            await socialLending.connect(borrower).requestLoan(LOAN_AMOUNT, INTEREST_RATE, DURATION, await mockToken.getAddress(), COLLATERAL_AMOUNT);
        });

        it("should revert requestLoan when paused", async function () {
            await socialLending.pause();
            await expect(
                socialLending.connect(borrower).requestLoan(LOAN_AMOUNT, INTEREST_RATE, DURATION, await mockToken.getAddress(), COLLATERAL_AMOUNT)
            ).to.be.revertedWith("Pausable: paused");
        });

        it("should revert fundLoan when paused", async function () {
            await socialLending.pause();
            await expect(
                socialLending.connect(lender).fundLoan(0, { value: LOAN_AMOUNT })
            ).to.be.revertedWith("Pausable: paused");
        });

        it("should revert repayLoan when paused", async function () {
            // Fund loan first
            await socialLending.connect(lender).fundLoan(0, { value: LOAN_AMOUNT });

            await socialLending.pause();
            await expect(
                socialLending.connect(borrower).repayLoan(0, { value: LOAN_AMOUNT })
            ).to.be.revertedWith("Pausable: paused");
        });

        it("should revert declareDefault when paused", async function () {
            // Fund loan first
            await socialLending.connect(lender).fundLoan(0, { value: LOAN_AMOUNT });

            // Advance time to default
            await ethers.provider.send("evm_increaseTime", [DURATION + 1]);
            await ethers.provider.send("evm_mine");

            await socialLending.pause();
            await expect(
                socialLending.connect(lender).declareDefault(0)
            ).to.be.revertedWith("Pausable: paused");
        });

        it("should revert checkAndDeclareDefault when paused", async function () {
            // Fund loan first
            await socialLending.connect(lender).fundLoan(0, { value: LOAN_AMOUNT });

            // Advance time to default
            await ethers.provider.send("evm_increaseTime", [DURATION + 1]);
            await ethers.provider.send("evm_mine");

            await socialLending.pause();
            await expect(
                socialLending.checkAndDeclareDefault(0)
            ).to.be.revertedWith("Pausable: paused");
        });

        it("should revert cancelLoanRequest when paused", async function () {
            await socialLending.pause();
            await expect(
                socialLending.connect(borrower).cancelLoanRequest(0)
            ).to.be.revertedWith("Pausable: paused");
        });

        it("should allow functions after unpause", async function () {
            await socialLending.pause();
            await socialLending.unpause();

            // Should succeed
            await expect(
                socialLending.connect(borrower).cancelLoanRequest(0)
            ).to.emit(socialLending, "LoanCancelled")
                .withArgs(0, borrower.address);
        });
    });
});
