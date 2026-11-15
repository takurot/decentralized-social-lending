const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Coverage Branch Completion (Issue #16)", function () {
    let lending, mockToken, mockPriceFeed;
    let owner, borrower, lender, other;

    beforeEach(async function () {
        [owner, borrower, lender, other] = await ethers.getSigners();

        const MockERC20 = await ethers.getContractFactory("MockERC20");
        mockToken = await MockERC20.deploy("Mock Token", "MTK", 18);
        await mockToken.waitForDeployment();

        const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed");
        mockPriceFeed = await MockPriceFeed.deploy();
        await mockPriceFeed.waitForDeployment();
        await mockPriceFeed.setLatestPrice(ethers.parseUnits("2", 8));

        const Lending = await ethers.getContractFactory("SocialLendingWithCollateral");
        lending = await Lending.deploy(owner.address);
        await lending.waitForDeployment();

        const tokenAddr = await mockToken.getAddress();
        await lending.setCollateralTokenStatus(tokenAddr, true);
        await lending.setCollateralTokenDecimals(tokenAddr, 18);
        await lending.setPriceFeed(tokenAddr, await mockPriceFeed.getAddress());

        await mockToken.mint(borrower.address, ethers.parseEther("1000"));
        await mockToken.connect(borrower).approve(await lending.getAddress(), ethers.parseEther("1000"));
    });

    it("should revert constructor with zero feeRecipient", async function () {
        const Lending = await ethers.getContractFactory("SocialLendingWithCollateral");
        await expect(Lending.deploy(ethers.ZeroAddress))
            .to.be.revertedWithCustomError(Lending, "InvalidAddress");
    });

    it("should revert requestLoan on invalid parameters and disallowed token", async function () {
        const tokenAddr = await mockToken.getAddress();
        await expect(lending.connect(borrower).requestLoan(0, 500, 86400, tokenAddr, ethers.parseEther("1")))
            .to.be.revertedWithCustomError(lending, "InvalidAmount");
        await expect(lending.connect(borrower).requestLoan(ethers.parseEther("1"), 0, 86400, tokenAddr, ethers.parseEther("1")))
            .to.be.revertedWithCustomError(lending, "InvalidInterestRate");
        await expect(lending.connect(borrower).requestLoan(ethers.parseEther("1"), 500, 0, tokenAddr, ethers.parseEther("1")))
            .to.be.revertedWithCustomError(lending, "InvalidDuration");
        await expect(lending.connect(borrower).requestLoan(ethers.parseEther("1"), 500, 86400, tokenAddr, 0))
            .to.be.revertedWithCustomError(lending, "InvalidCollateral");
        await expect(lending.connect(borrower).requestLoan(ethers.parseEther("1"), 500, 86400, ethers.ZeroAddress, ethers.parseEther("1")))
            .to.be.revertedWithCustomError(lending, "InvalidAddress");

        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const disallowed = await MockERC20.deploy("Other", "OTH", 18);
        await expect(lending.connect(borrower).requestLoan(ethers.parseEther("1"), 500, 86400, await disallowed.getAddress(), ethers.parseEther("1")))
            .to.be.revertedWithCustomError(lending, "TokenNotAllowed");
    });

    it("should revert fundLoan, repayLoan, declareDefault, checkAndDeclareDefault, getCollateralizationRatio on invalid loanId", async function () {
        await expect(lending.connect(lender).fundLoan(999, { value: ethers.parseEther("1") }))
            .to.be.revertedWithCustomError(lending, "InvalidLoanId");
        await expect(lending.connect(borrower).repayLoan(999, { value: ethers.parseEther("1") }))
            .to.be.revertedWithCustomError(lending, "InvalidLoanId");
        await expect(lending.connect(lender).declareDefault(999))
            .to.be.revertedWithCustomError(lending, "InvalidLoanId");
        await expect(lending.connect(other).checkAndDeclareDefault(999))
            .to.be.revertedWithCustomError(lending, "InvalidLoanId");
        await expect(lending.getCollateralizationRatio(999))
            .to.be.revertedWithCustomError(lending, "InvalidLoanId");
    });

    it("should revert fundLoan on self-funding and wrong state", async function () {
        const tokenAddr = await mockToken.getAddress();
        await lending.connect(borrower).requestLoan(ethers.parseEther("1"), 500, 86400, tokenAddr, ethers.parseEther("1"));

        await expect(lending.connect(borrower).fundLoan(0, { value: ethers.parseEther("1") }))
            .to.be.revertedWithCustomError(lending, "SelfFunding");

        await lending.connect(lender).fundLoan(0, { value: ethers.parseEther("1") });
        await expect(lending.connect(other).fundLoan(0, { value: ethers.parseEther("1") }))
            .to.be.revertedWithCustomError(lending, "InvalidLoanState");
    });

    it("should revert repayLoan on wrong state or zero value", async function () {
        const tokenAddr = await mockToken.getAddress();
        await lending.connect(borrower).requestLoan(ethers.parseEther("1"), 500, 86400, tokenAddr, ethers.parseEther("1"));

        await expect(lending.connect(borrower).repayLoan(0, { value: ethers.parseEther("1") }))
            .to.be.revertedWithCustomError(lending, "InvalidLoanState");

        await lending.connect(lender).fundLoan(0, { value: ethers.parseEther("1") });
        await expect(lending.connect(borrower).repayLoan(0, { value: 0 }))
            .to.be.revertedWithCustomError(lending, "InvalidAmount");
    });

    it("should revert declareDefault and checkAndDeclareDefault on wrong state, unauthorized, or not expired", async function () {
        const tokenAddr = await mockToken.getAddress();
        await lending.connect(borrower).requestLoan(ethers.parseEther("1"), 500, 86400, tokenAddr, ethers.parseEther("1"));

        await expect(lending.connect(lender).declareDefault(0))
            .to.be.revertedWithCustomError(lending, "Unauthorized");
        await expect(lending.connect(other).checkAndDeclareDefault(0))
            .to.be.revertedWithCustomError(lending, "InvalidLoanState");

        await lending.connect(lender).fundLoan(0, { value: ethers.parseEther("1") });

        await expect(lending.connect(other).declareDefault(0))
            .to.be.revertedWithCustomError(lending, "Unauthorized");
        await expect(lending.connect(other).checkAndDeclareDefault(0))
            .to.be.revertedWithCustomError(lending, "LoanNotExpired");

        // Repay loan fully, then declareDefault should revert with InvalidLoanState
        const loan = await lending.loans(0);
        await lending.connect(borrower).repayLoan(0, { value: loan.repaymentAmount });
        await expect(lending.connect(lender).declareDefault(0))
            .to.be.revertedWithCustomError(lending, "InvalidLoanState");
    });

    it("should revert getCollateralizationRatio on non-funded loan", async function () {
        const tokenAddr = await mockToken.getAddress();
        await lending.connect(borrower).requestLoan(ethers.parseEther("1"), 500, 86400, tokenAddr, ethers.parseEther("1"));

        await expect(lending.getCollateralizationRatio(0))
            .to.be.revertedWithCustomError(lending, "InvalidLoanState");
    });

    it("should revert getCollateralValueInETH on missing feed and invalid/stale oracle data", async function () {
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const noFeedToken = await MockERC20.deploy("NoFeed", "NF", 18);
        await expect(lending.getCollateralValueInETH(await noFeedToken.getAddress(), ethers.parseEther("1")))
            .to.be.revertedWithCustomError(lending, "PriceFeedNotAvailable");

        const tokenAddr = await mockToken.getAddress();

        // price <= 0
        await mockPriceFeed.setLatestPrice(0);
        await expect(lending.getCollateralValueInETH(tokenAddr, ethers.parseEther("1")))
            .to.be.revertedWithCustomError(lending, "InvalidPriceData");

        // startedAt == 0
        const now = await time.latest();
        await mockPriceFeed.setPriceData(ethers.parseUnits("2", 8), 1, 0, now, 1);
        await expect(lending.getCollateralValueInETH(tokenAddr, ethers.parseEther("1")))
            .to.be.revertedWithCustomError(lending, "InvalidPriceData");

        // updatedAt == 0
        await mockPriceFeed.setPriceData(ethers.parseUnits("2", 8), 1, now, 0, 1);
        await expect(lending.getCollateralValueInETH(tokenAddr, ethers.parseEther("1")))
            .to.be.revertedWithCustomError(lending, "InvalidPriceData");

        // updatedAt < startedAt
        await mockPriceFeed.setPriceData(ethers.parseUnits("2", 8), 1, now, now - 10, 1);
        await expect(lending.getCollateralValueInETH(tokenAddr, ethers.parseEther("1")))
            .to.be.revertedWithCustomError(lending, "InvalidPriceData");

        // stale updatedAt
        await mockPriceFeed.setPriceData(ethers.parseUnits("2", 8), 1, now - 7200, now - 7200, 1);
        await expect(lending.getCollateralValueInETH(tokenAddr, ethers.parseEther("1")))
            .to.be.revertedWithCustomError(lending, "StaleData");

        // answeredInRound < roundId
        await mockPriceFeed.setPriceData(ethers.parseUnits("2", 8), 5, now, now, 4);
        await expect(lending.getCollateralValueInETH(tokenAddr, ethers.parseEther("1")))
            .to.be.revertedWithCustomError(lending, "StaleData");
    });

    it("should revert rescueETH when amount exceeds contract balance and rescueTokens on zero recipient", async function () {
        await expect(lending.rescueETH(ethers.parseEther("10"), owner.address))
            .to.be.revertedWithCustomError(lending, "InsufficientUnlockedETH");
        await expect(lending.rescueTokens(await mockToken.getAddress(), 1, ethers.ZeroAddress))
            .to.be.revertedWithCustomError(lending, "InvalidAddress");
    });

    it("should cover acceptLoanOffer validation revert branches", async function () {
        const tokenAddr = await mockToken.getAddress();
        await lending.connect(lender).createLoanOffer(1000, 86400, 30 * 86400, tokenAddr, 15000, {
            value: ethers.parseEther("1")
        });

        await expect(lending.connect(borrower).acceptLoanOffer(0, 0, 86400, tokenAddr, ethers.parseEther("1")))
            .to.be.revertedWithCustomError(lending, "InvalidInterestRate");
        await expect(lending.connect(borrower).acceptLoanOffer(0, 1001, 86400, tokenAddr, ethers.parseEther("1")))
            .to.be.revertedWithCustomError(lending, "InvalidInterestRate");
        await expect(lending.connect(borrower).acceptLoanOffer(0, 500, 100, tokenAddr, ethers.parseEther("1")))
            .to.be.revertedWithCustomError(lending, "InvalidDuration");
        await expect(lending.connect(borrower).acceptLoanOffer(0, 500, 31 * 86400, tokenAddr, ethers.parseEther("1")))
            .to.be.revertedWithCustomError(lending, "InvalidDuration");
        await expect(lending.connect(borrower).acceptLoanOffer(0, 500, 86400, tokenAddr, 0))
            .to.be.revertedWithCustomError(lending, "InvalidCollateral");
        await expect(lending.connect(borrower).acceptLoanOffer(0, 500, 86400, ethers.ZeroAddress, ethers.parseEther("1")))
            .to.be.revertedWithCustomError(lending, "InvalidAddress");

        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const otherToken = await MockERC20.deploy("Other", "OTH", 18);
        const otherAddr = await otherToken.getAddress();
        await expect(lending.connect(borrower).acceptLoanOffer(0, 500, 86400, otherAddr, ethers.parseEther("1")))
            .to.be.revertedWithCustomError(lending, "TokenNotAllowed");

        await lending.setCollateralTokenStatus(otherAddr, true);
        await expect(lending.connect(borrower).acceptLoanOffer(0, 500, 86400, otherAddr, ethers.parseEther("1")))
            .to.be.revertedWithCustomError(lending, "TokenNotAllowed");

        await lending.setMaxActiveLoansPerBorrower(1);
        await lending.connect(borrower).acceptLoanOffer(0, 500, 86400, tokenAddr, ethers.parseEther("1"));

        await lending.connect(lender).createLoanOffer(1000, 86400, 30 * 86400, ethers.ZeroAddress, 15000, {
            value: ethers.parseEther("1")
        });
        await expect(lending.connect(borrower).acceptLoanOffer(1, 500, 86400, tokenAddr, ethers.parseEther("1")))
            .to.be.revertedWithCustomError(lending, "TooManyActiveLoans");
    });
});
