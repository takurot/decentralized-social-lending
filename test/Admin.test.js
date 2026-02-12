const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SocialLendingWithCollateral Admin", function () {
    let socialLending;
    let owner, user, mockToken, mockPriceFeed;

    beforeEach(async function () {
        [owner, user] = await ethers.getSigners();

        const MockERC20Factory = await ethers.getContractFactory("MockERC20");
        mockToken = await MockERC20Factory.deploy("Mock", "MOCK", 18);

        const MockPriceFeedFactory = await ethers.getContractFactory("MockPriceFeed");
        mockPriceFeed = await MockPriceFeedFactory.deploy();

        const SocialLendingFactory = await ethers.getContractFactory("SocialLendingWithCollateral");
        socialLending = await SocialLendingFactory.deploy(owner.address);
    });

    describe("Configuration Setters", function () {
        it("should set platform fee successfully", async function () {
            await expect(socialLending.setPlatformFee(200))
                .to.emit(socialLending, "PlatformFeeUpdated")
                .withArgs(200);
            expect(await socialLending.platformFee()).to.equal(200);
        });

        it("should revert if platform fee > MAX", async function () {
            const maxFee = await socialLending.MAX_PLATFORM_FEE();
            await expect(socialLending.setPlatformFee(maxFee + 1n))
                .to.be.revertedWithCustomError(socialLending, "InvalidParameter");
        });

        it("should set fee recipient successfully", async function () {
            await expect(socialLending.setFeeRecipient(user.address))
                .to.emit(socialLending, "FeeRecipientUpdated")
                .withArgs(user.address);
            expect(await socialLending.feeRecipient()).to.equal(user.address);
        });

        it("should revert if fee recipient is zero address", async function () {
            await expect(socialLending.setFeeRecipient(ethers.ZeroAddress))
                .to.be.revertedWithCustomError(socialLending, "InvalidAddress");
        });

        it("should set collateral ratio successfully", async function () {
            await expect(socialLending.setCollateralRatio(12000))
                .to.emit(socialLending, "CollateralRatioUpdated")
                .withArgs(12000);
            expect(await socialLending.collateralRatio()).to.equal(12000);
        });

        it("should revert if collateral ratio is out of bounds", async function () {
            const min = await socialLending.MIN_COLLATERAL_RATIO();
            const max = await socialLending.MAX_COLLATERAL_RATIO();

            await expect(socialLending.setCollateralRatio(min - 1n))
                .to.be.revertedWithCustomError(socialLending, "InvalidParameter");

            await expect(socialLending.setCollateralRatio(max + 1n))
                .to.be.revertedWithCustomError(socialLending, "InvalidParameter");
        });

        it("should set collateral token status", async function () {
            const token = await mockToken.getAddress();
            await expect(socialLending.setCollateralTokenStatus(token, true))
                .to.emit(socialLending, "CollateralTokenStatusUpdated")
                .withArgs(token, true);
            expect(await socialLending.allowedCollateralTokens(token)).to.be.true;
        });

        it("should revert setCollateralTokenStatus for zero address", async function () {
            await expect(socialLending.setCollateralTokenStatus(ethers.ZeroAddress, true))
                .to.be.revertedWithCustomError(socialLending, "InvalidAddress");
        });

        it("should set collateral token decimals", async function () {
            const token = await mockToken.getAddress();
            await expect(socialLending.setCollateralTokenDecimals(token, 6))
                .to.emit(socialLending, "CollateralTokenDecimalsUpdated")
                .withArgs(token, 6);
            expect(await socialLending.collateralTokenDecimals(token)).to.equal(6);
        });

        it("should revert setCollateralTokenDecimals invalid params", async function () {
            const token = await mockToken.getAddress();
            await expect(socialLending.setCollateralTokenDecimals(ethers.ZeroAddress, 18))
                .to.be.revertedWithCustomError(socialLending, "InvalidAddress");
            await expect(socialLending.setCollateralTokenDecimals(token, 19))
                .to.be.revertedWithCustomError(socialLending, "InvalidParameter");
        });

        it("should set price feed", async function () {
            const token = await mockToken.getAddress();
            const feed = await mockPriceFeed.getAddress();
            await expect(socialLending.setPriceFeed(token, feed))
                .to.emit(socialLending, "PriceFeedUpdated")
                .withArgs(token, feed);
            expect(await socialLending.priceFeeds(token)).to.equal(feed);
        });

        it("should revert setPriceFeed invalid params", async function () {
            const token = await mockToken.getAddress();
            const feed = await mockPriceFeed.getAddress();
            await expect(socialLending.setPriceFeed(ethers.ZeroAddress, feed))
                .to.be.revertedWithCustomError(socialLending, "InvalidAddress");
            await expect(socialLending.setPriceFeed(token, ethers.ZeroAddress))
                .to.be.revertedWithCustomError(socialLending, "InvalidAddress");
        });
    });

    describe("Pausable", function () {
        it("should allow owner to pause and unpause", async function () {
            await socialLending.pause();
            expect(await socialLending.paused()).to.be.true;

            // Verify function reverts when paused
            const loanAmount = ethers.parseEther("1");
            const collateralAmount = ethers.parseEther("1");
            await expect(socialLending.connect(user).requestLoan(loanAmount, 500, 3600, await mockToken.getAddress(), collateralAmount))
                .to.be.revertedWith("Pausable: paused");

            await socialLending.unpause();
            expect(await socialLending.paused()).to.be.false;
        });
    });

    describe("Emergency Functions", function () {
        it("should rescue ETH", async function () {
            // Send ETH to contract
            await owner.sendTransaction({
                to: await socialLending.getAddress(),
                value: ethers.parseEther("1.0")
            });

            const initialBalance = await ethers.provider.getBalance(user.address);
            await socialLending.rescueETH(ethers.parseEther("1.0"), user.address);
            const finalBalance = await ethers.provider.getBalance(user.address);

            expect(finalBalance - initialBalance).to.equal(ethers.parseEther("1.0"));
        });

        it("should revert rescueETH invalid address", async function () {
            await expect(socialLending.rescueETH(100, ethers.ZeroAddress))
                .to.be.revertedWithCustomError(socialLending, "InvalidAddress");
        });
    });
});
