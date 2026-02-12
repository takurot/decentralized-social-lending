const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SocialLendingWithCollateral View Functions", function () {
    let socialLending;
    let owner, borrower, lender, mockToken, mockPriceFeed;

    beforeEach(async function () {
        [owner, borrower, lender] = await ethers.getSigners();

        const MockERC20Factory = await ethers.getContractFactory("MockERC20");
        mockToken = await MockERC20Factory.deploy("Mock", "MOCK", 18);

        const MockPriceFeedFactory = await ethers.getContractFactory("MockPriceFeed");
        mockPriceFeed = await MockPriceFeedFactory.deploy();

        const SocialLendingFactory = await ethers.getContractFactory("SocialLendingWithCollateral");
        socialLending = await SocialLendingFactory.deploy(owner.address);

        await socialLending.setCollateralTokenStatus(await mockToken.getAddress(), true);
        await socialLending.setCollateralTokenDecimals(await mockToken.getAddress(), 18);
        await socialLending.setPriceFeed(await mockToken.getAddress(), await mockPriceFeed.getAddress());

        await mockToken.mint(borrower.address, ethers.parseEther("1000"));
        await mockToken.connect(borrower).approve(await socialLending.getAddress(), ethers.parseEther("1000"));

        await mockPriceFeed.setLatestPrice(ethers.parseUnits("2000", 8));
    });

    it("should return correct borrower loans", async function () {
        // Create 2 loans
        await socialLending.connect(borrower).requestLoan(ethers.parseEther("0.1"), 500, 3600, await mockToken.getAddress(), ethers.parseEther("0.1"));
        await socialLending.connect(borrower).requestLoan(ethers.parseEther("0.2"), 500, 3600, await mockToken.getAddress(), ethers.parseEther("0.2"));

        const loans = await socialLending.getBorrowerLoans(borrower.address);
        expect(loans.length).to.equal(2);
        expect(loans[0]).to.equal(0);
        expect(loans[1]).to.equal(1);
    });

    it("should return correct lender loans", async function () {
        // Create loan
        await socialLending.connect(borrower).requestLoan(ethers.parseEther("1.0"), 500, 3600, await mockToken.getAddress(), ethers.parseEther("1.0"));

        // Fund loan
        await socialLending.connect(lender).fundLoan(0, { value: ethers.parseEther("1.0") });

        const loans = await socialLending.getLenderLoans(lender.address);
        expect(loans.length).to.equal(1);
        expect(loans[0]).to.equal(0);
    });

    it("should return correct stats", async function () {
        // 0: Funding
        await socialLending.connect(borrower).requestLoan(ethers.parseEther("1.0"), 500, 3600, await mockToken.getAddress(), ethers.parseEther("1.0"));
        await socialLending.connect(lender).fundLoan(0, { value: ethers.parseEther("1.0") });

        // 1: Repaid
        await socialLending.connect(borrower).requestLoan(ethers.parseEther("1.0"), 500, 3600, await mockToken.getAddress(), ethers.parseEther("1.0"));
        await socialLending.connect(lender).fundLoan(1, { value: ethers.parseEther("1.0") });
        const loan1 = await socialLending.loans(1);
        await socialLending.connect(borrower).repayLoan(1, { value: loan1.repaymentAmount }); // Full repay

        // 2: Cancelled
        await socialLending.connect(borrower).requestLoan(ethers.parseEther("1.0"), 500, 3600, await mockToken.getAddress(), ethers.parseEther("1.0"));
        await socialLending.connect(borrower).cancelLoanRequest(2);

        const stats = await socialLending.getStats();
        // totalLoans, activeLoans, repaidLoans, defaultedLoans, cancelledLoans
        // total: 3. (Active: 0 is Active. Repaid: 1. Cancelled: 2.)

        expect(stats.totalLoans).to.equal(3);
        expect(stats.activeLoans).to.equal(1);
        expect(stats.repaidLoans).to.equal(1);
        expect(stats.cancelledLoans).to.equal(1);
        expect(stats.defaultedLoans).to.equal(0);
    });
});
