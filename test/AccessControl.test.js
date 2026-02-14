const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Access Control", function () {
    let socialLending;
    let owner, otherUser, mockToken, mockPriceFeed;

    beforeEach(async function () {
        [owner, otherUser] = await ethers.getSigners();

        // Deploy Mock Token
        const MockToken = await ethers.getContractFactory("MockERC20");
        mockToken = await MockToken.deploy("Mock", "MOCK", 18);
        await mockToken.waitForDeployment();

        // Deploy Mock Price Feed
        const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed");
        mockPriceFeed = await MockPriceFeed.deploy();
        await mockPriceFeed.waitForDeployment();

        // Deploy Social Lending
        const SocialLending = await ethers.getContractFactory("SocialLendingWithCollateral");
        socialLending = await SocialLending.deploy(owner.address);
        await socialLending.waitForDeployment();
    });

    it("should revert setPlatformFee if called by non-owner", async function () {
        await expect(socialLending.connect(otherUser).setPlatformFee(200))
            .to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should revert setFeeRecipient if called by non-owner", async function () {
        await expect(socialLending.connect(otherUser).setFeeRecipient(otherUser.address))
            .to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should revert setCollateralRatio if called by non-owner", async function () {
        await expect(socialLending.connect(otherUser).setCollateralRatio(12000))
            .to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should revert setCollateralTokenStatus if called by non-owner", async function () {
        await expect(socialLending.connect(otherUser).setCollateralTokenStatus(await mockToken.getAddress(), true))
            .to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should revert setCollateralTokenDecimals if called by non-owner", async function () {
        await expect(socialLending.connect(otherUser).setCollateralTokenDecimals(await mockToken.getAddress(), 18))
            .to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should revert setPriceFeed if called by non-owner", async function () {
        await expect(socialLending.connect(otherUser).setPriceFeed(await mockToken.getAddress(), await mockPriceFeed.getAddress()))
            .to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should revert rescueETH if called by non-owner", async function () {
        await expect(socialLending.connect(otherUser).rescueETH(0, otherUser.address))
            .to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should revert rescueTokens if called by non-owner", async function () {
        await expect(socialLending.connect(otherUser).rescueTokens(await mockToken.getAddress(), 0, otherUser.address))
            .to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should revert setMaxLoanAmount if called by non-owner", async function () {
        await expect(socialLending.connect(otherUser).setMaxLoanAmount(ethers.parseEther("5")))
            .to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should revert setMaxLoanAmount with invalid parameter", async function () {
        await expect(socialLending.setMaxLoanAmount(0))
            .to.be.revertedWithCustomError(socialLending, "InvalidParameter");
    });

    it("should revert setMaxActiveLoansPerBorrower if called by non-owner", async function () {
        await expect(socialLending.connect(otherUser).setMaxActiveLoansPerBorrower(5))
            .to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should revert setMaxActiveLoansPerBorrower with invalid parameter", async function () {
        await expect(socialLending.setMaxActiveLoansPerBorrower(0))
            .to.be.revertedWithCustomError(socialLending, "InvalidParameter");
    });

    it("should revert setCollateralTokenStatus with invalid address", async function () {
        await expect(socialLending.setCollateralTokenStatus(ethers.ZeroAddress, true))
            .to.be.revertedWithCustomError(socialLending, "InvalidAddress");
    });

    it("should revert setCollateralTokenDecimals with invalid address", async function () {
        await expect(socialLending.setCollateralTokenDecimals(ethers.ZeroAddress, 18))
            .to.be.revertedWithCustomError(socialLending, "InvalidAddress");
    });

    it("should revert setCollateralTokenDecimals with invalid decimals", async function () {
        await expect(socialLending.setCollateralTokenDecimals(await mockToken.getAddress(), 19))
            .to.be.revertedWithCustomError(socialLending, "InvalidParameter");
    });

    it("should revert setPriceFeed with invalid address", async function () {
        await expect(socialLending.setPriceFeed(ethers.ZeroAddress, await mockPriceFeed.getAddress()))
            .to.be.revertedWithCustomError(socialLending, "InvalidAddress");
        await expect(socialLending.setPriceFeed(await mockToken.getAddress(), ethers.ZeroAddress))
            .to.be.revertedWithCustomError(socialLending, "InvalidAddress");
    });

    it("should allow receiving ETH", async function () {
        // Send ETH to contract
        await owner.sendTransaction({
            to: await socialLending.getAddress(),
            value: ethers.parseEther("1")
        });

        expect(await ethers.provider.getBalance(await socialLending.getAddress())).to.equal(ethers.parseEther("1"));
    });

    it("should allow owner to setMaxLoanAmount", async function () {
        await expect(socialLending.setMaxLoanAmount(ethers.parseEther("20")))
            .to.emit(socialLending, "MaxLoanAmountUpdated")
            .withArgs(ethers.parseEther("20"));
        expect(await socialLending.maxLoanAmount()).to.equal(ethers.parseEther("20"));
    });

    it("should allow owner to setMaxActiveLoansPerBorrower", async function () {
        await expect(socialLending.setMaxActiveLoansPerBorrower(10))
            .to.emit(socialLending, "MaxActiveLoansPerBorrowerUpdated")
            .withArgs(10);
        expect(await socialLending.maxActiveLoansPerBorrower()).to.equal(10);
    });

    it("should allow owner to setCollateralTokenStatus", async function () {
        await expect(socialLending.setCollateralTokenStatus(await mockToken.getAddress(), false))
            .to.emit(socialLending, "CollateralTokenStatusUpdated")
            .withArgs(await mockToken.getAddress(), false);
        expect(await socialLending.allowedCollateralTokens(await mockToken.getAddress())).to.be.false;
    });

    it("should allow owner to setCollateralTokenDecimals", async function () {
        await expect(socialLending.setCollateralTokenDecimals(await mockToken.getAddress(), 6))
            .to.emit(socialLending, "CollateralTokenDecimalsUpdated")
            .withArgs(await mockToken.getAddress(), 6);
        expect(await socialLending.collateralTokenDecimals(await mockToken.getAddress())).to.equal(6);
    });

    it("should allow owner to setPriceFeed", async function () {
        const newFeed = otherUser.address; // Just a random address for test
        await expect(socialLending.setPriceFeed(await mockToken.getAddress(), newFeed))
            .to.emit(socialLending, "PriceFeedUpdated")
            .withArgs(await mockToken.getAddress(), newFeed);
        expect(await socialLending.priceFeeds(await mockToken.getAddress())).to.equal(newFeed);
    });

    it("should allow owner to setPlatformFee", async function () {
        await expect(socialLending.setPlatformFee(200))
            .to.emit(socialLending, "PlatformFeeUpdated")
            .withArgs(200);
        expect(await socialLending.platformFee()).to.equal(200);
    });

    it("should allow owner to setFeeRecipient", async function () {
        await expect(socialLending.setFeeRecipient(otherUser.address))
            .to.emit(socialLending, "FeeRecipientUpdated")
            .withArgs(otherUser.address);
        expect(await socialLending.feeRecipient()).to.equal(otherUser.address);
    });

    it("should allow owner to setCollateralRatio", async function () {
        await expect(socialLending.setCollateralRatio(13000))
            .to.emit(socialLending, "CollateralRatioUpdated")
            .withArgs(13000);
        expect(await socialLending.collateralRatio()).to.equal(13000);
    });
});
