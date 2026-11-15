const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Social Credit Score System (PR-07)", function () {
    let socialLending;
    let owner, borrower, lender, other, mockToken, mockPriceFeed;
    const DURATION = 30 * 24 * 60 * 60;
    const INTEREST_RATE = 500; // 5%

    beforeEach(async function () {
        [owner, borrower, lender, other] = await ethers.getSigners();

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

        await mockToken.mint(borrower.address, ethers.parseEther("1000"));
        await mockToken.connect(borrower).approve(await socialLending.getAddress(), ethers.parseEther("1000"));
    });

    it("should return neutral score 5000 for a new user", async function () {
        expect(await socialLending.getCreditScore(borrower.address)).to.equal(5000);
        const rep = await socialLending.userReputations(borrower.address);
        expect(rep.totalLoans).to.equal(0);
    });

    it("should not penalize cancelled loan requests", async function () {
        await socialLending.connect(borrower).requestLoan(
            ethers.parseEther("1"),
            INTEREST_RATE,
            DURATION,
            await mockToken.getAddress(),
            ethers.parseEther("2")
        );
        await socialLending.connect(borrower).cancelLoanRequest(0);

        expect(await socialLending.getCreditScore(borrower.address)).to.equal(5000);
        const rep = await socialLending.userReputations(borrower.address);
        expect(rep.totalLoans).to.equal(0);
        expect(rep.totalBorrowedAmount).to.equal(0);
    });

    it("should track partial + full repayment accurately and raise score to 10000", async function () {
        const loanAmount = ethers.parseEther("1");
        await socialLending.connect(borrower).requestLoan(
            loanAmount,
            INTEREST_RATE,
            DURATION,
            await mockToken.getAddress(),
            ethers.parseEther("2")
        );

        await expect(socialLending.connect(lender).fundLoan(0, { value: loanAmount }))
            .to.emit(socialLending, "ReputationUpdated")
            .withArgs(borrower.address, 1, 0, 0);

        const loan = await socialLending.loans(0);
        const firstHalf = loan.repaymentAmount / 2n;
        const secondHalf = loan.repaymentAmount - firstHalf;

        await expect(socialLending.connect(borrower).repayLoan(0, { value: firstHalf }))
            .to.emit(socialLending, "ReputationUpdated")
            .withArgs(borrower.address, 1, 0, 0);

        let rep = await socialLending.userReputations(borrower.address);
        expect(rep.totalRepaidAmount).to.equal(firstHalf);
        expect(rep.repaidLoans).to.equal(0);

        await expect(socialLending.connect(borrower).repayLoan(0, { value: secondHalf }))
            .to.emit(socialLending, "ReputationUpdated")
            .withArgs(borrower.address, 1, 1, 0);

        rep = await socialLending.userReputations(borrower.address);
        expect(rep.totalLoans).to.equal(1);
        expect(rep.repaidLoans).to.equal(1);
        expect(rep.totalBorrowedAmount).to.equal(loanAmount);
        expect(rep.totalRepaidAmount).to.equal(loan.repaymentAmount);
        expect(rep.lastActivityTimestamp).to.be.gt(0);

        expect(await socialLending.getCreditScore(borrower.address)).to.equal(10000);
    });

    it("should lower score on declareDefault and checkAndDeclareDefault", async function () {
        const loanAmount = ethers.parseEther("1");
        await socialLending.connect(borrower).requestLoan(
            loanAmount,
            INTEREST_RATE,
            DURATION,
            await mockToken.getAddress(),
            ethers.parseEther("2")
        );
        await socialLending.connect(lender).fundLoan(0, { value: loanAmount });

        await ethers.provider.send("evm_increaseTime", [DURATION + 1]);
        await ethers.provider.send("evm_mine");

        await expect(socialLending.connect(lender).declareDefault(0))
            .to.emit(socialLending, "ReputationUpdated")
            .withArgs(borrower.address, 1, 0, 1);

        expect(await socialLending.getCreditScore(borrower.address)).to.equal(0);

        // Refresh oracle timestamp after evm_increaseTime
        await mockPriceFeed.setLatestPrice(ethers.parseUnits("1", 8));

        // Second loan defaulted via checkAndDeclareDefault
        await socialLending.connect(borrower).requestLoan(
            loanAmount,
            INTEREST_RATE,
            DURATION,
            await mockToken.getAddress(),
            ethers.parseEther("2")
        );
        await socialLending.connect(lender).fundLoan(1, { value: loanAmount });

        await ethers.provider.send("evm_increaseTime", [DURATION + 1]);
        await ethers.provider.send("evm_mine");

        await expect(socialLending.connect(other).checkAndDeclareDefault(1))
            .to.emit(socialLending, "ReputationUpdated")
            .withArgs(borrower.address, 2, 0, 2);

        const rep = await socialLending.userReputations(borrower.address);
        expect(rep.defaultedLoans).to.equal(2);
        expect(await socialLending.getCreditScore(borrower.address)).to.equal(0);
    });

    it("should award volume bonuses (> 10 ether = +500, > 100 ether = +1000) and cap at 10000", async function () {
        await socialLending.connect(owner).setMaxLoanAmount(ethers.parseEther("200"));

        // 1) Repay 11 ETH loan => totalRepaidAmount > 10 ether (+500 bonus), 1/1 repaid => capped at 10000
        const amount11 = ethers.parseEther("11");
        await socialLending.connect(borrower).requestLoan(
            amount11,
            INTEREST_RATE,
            DURATION,
            await mockToken.getAddress(),
            ethers.parseEther("25")
        );
        await socialLending.connect(lender).fundLoan(0, { value: amount11 });
        const loan0 = await socialLending.loans(0);
        await socialLending.connect(borrower).repayLoan(0, { value: loan0.repaymentAmount });
        expect(await socialLending.getCreditScore(borrower.address)).to.equal(10000);

        // 2) Default 1 ETH loan => 1/2 repaid = 5000 base + 500 volume bonus = 5500
        const amount1 = ethers.parseEther("1");
        await socialLending.connect(borrower).requestLoan(
            amount1,
            INTEREST_RATE,
            DURATION,
            await mockToken.getAddress(),
            ethers.parseEther("2")
        );
        await socialLending.connect(lender).fundLoan(1, { value: amount1 });
        await ethers.provider.send("evm_increaseTime", [DURATION + 1]);
        await ethers.provider.send("evm_mine");
        await socialLending.connect(lender).declareDefault(1);
        expect(await socialLending.getCreditScore(borrower.address)).to.equal(5500);

        // Refresh oracle timestamp after evm_increaseTime
        await mockPriceFeed.setLatestPrice(ethers.parseUnits("1", 8));

        // 3) Repay 95 ETH loan => totalRepaidAmount > 100 ether (+1000 bonus), 2/3 repaid = 6666 + 1000 = 7666
        const amount95 = ethers.parseEther("95");
        await socialLending.connect(borrower).requestLoan(
            amount95,
            INTEREST_RATE,
            DURATION,
            await mockToken.getAddress(),
            ethers.parseEther("200")
        );
        await socialLending.connect(lender).fundLoan(2, { value: amount95 });
        const loan2 = await socialLending.loans(2);
        await socialLending.connect(borrower).repayLoan(2, { value: loan2.repaymentAmount });
        expect(await socialLending.getCreditScore(borrower.address)).to.equal(7666);
    });
});
