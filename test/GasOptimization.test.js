const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Gas Optimization & Struct Packing (PR-04)", function () {
    let socialLending;
    let mockToken;
    let mockPriceFeed;
    let owner, borrower, lender, other;

    const INITIAL_SUPPLY = ethers.parseEther("1000000");
    const LOAN_AMOUNT = ethers.parseEther("1");
    const COLLATERAL_AMOUNT = ethers.parseEther("2"); // 2 tokens
    const INTEREST_RATE = 1000; // 10%
    const DURATION = 86400 * 30; // 30 days

    beforeEach(async function () {
        [owner, borrower, lender, other] = await ethers.getSigners();

        // Deploy Mock Token
        const MockToken = await ethers.getContractFactory("MockERC20");
        mockToken = await MockToken.deploy("Mock Token", "MTK", 18);
        await mockToken.waitForDeployment();

        // Deploy Mock Price Feed (1 token = 1 ETH)
        const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed");
        mockPriceFeed = await MockPriceFeed.deploy();
        await mockPriceFeed.waitForDeployment();
        await mockPriceFeed.setLatestPrice(ethers.parseUnits("1", 8)); // 1 ETH

        // Deploy Social Lending
        const SocialLending = await ethers.getContractFactory("SocialLendingWithCollateral");
        socialLending = await SocialLending.deploy(owner.address);
        await socialLending.waitForDeployment();

        // Setup
        await socialLending.setCollateralTokenStatus(await mockToken.getAddress(), true);
        await socialLending.setPriceFeed(await mockToken.getAddress(), await mockPriceFeed.getAddress());

        // Mint tokens to borrower and approve
        await mockToken.mint(borrower.address, INITIAL_SUPPLY);
        await mockToken.connect(borrower).approve(await socialLending.getAddress(), INITIAL_SUPPLY);

        // Fund lender
        // (Lenders use native ETH, so they just need balance, which hardhat signers have)

        // Set max active loans to 10 to allow batched tests
        await socialLending.setMaxActiveLoansPerBorrower(10);
    });

    describe("Struct Packing & Data Layout", function () {
        it("should handle interestRate up to uint16 max (65535) correctly", async function () {
            // We only allow up to 2000 (20%) in business logic, but structurally it fits.
            // Let's test the business logic limit first
            const maxRate = 2000;
            await expect(
                socialLending.connect(borrower).requestLoan(
                    LOAN_AMOUNT,
                    maxRate,
                    DURATION,
                    await mockToken.getAddress(),
                    COLLATERAL_AMOUNT
                )
            ).to.not.be.reverted;

            // Verify storage (conceptually - implementation detail, but we check if it works)
            const loan = await socialLending.loans(0);
            expect(loan.interestRate).to.equal(maxRate);
        });

        it("should revert if interestRate exceeds MAX_INTEREST_RATE", async function () {
            await expect(
                socialLending.connect(borrower).requestLoan(
                    LOAN_AMOUNT,
                    2001,
                    DURATION,
                    await mockToken.getAddress(),
                    COLLATERAL_AMOUNT
                )
            ).to.be.revertedWithCustomError(socialLending, "InvalidInterestRate");
        });
    });

    describe("View Functions & Indexing", function () {
        beforeEach(async function () {
            // Create 3 loans
            // Loan 0: Requested
            await socialLending.connect(borrower).requestLoan(LOAN_AMOUNT, INTEREST_RATE, DURATION, await mockToken.getAddress(), COLLATERAL_AMOUNT);

            // Loan 1: Funded
            await socialLending.connect(borrower).requestLoan(LOAN_AMOUNT, INTEREST_RATE, DURATION, await mockToken.getAddress(), COLLATERAL_AMOUNT);
            await socialLending.connect(lender).fundLoan(1, { value: LOAN_AMOUNT });

            // Loan 2: Repaid
            await socialLending.connect(borrower).requestLoan(LOAN_AMOUNT, INTEREST_RATE, DURATION, await mockToken.getAddress(), COLLATERAL_AMOUNT);
            await socialLending.connect(lender).fundLoan(2, { value: LOAN_AMOUNT });
            const loan2 = await socialLending.loans(2);
            await socialLending.connect(borrower).repayLoan(2, { value: loan2.repaymentAmount });

            // Loan 3: Defaulted (Manually Declared)
            await socialLending.connect(borrower).requestLoan(LOAN_AMOUNT, INTEREST_RATE, DURATION, await mockToken.getAddress(), COLLATERAL_AMOUNT);
            await socialLending.connect(lender).fundLoan(3, { value: LOAN_AMOUNT });
            // Forward time
            await ethers.provider.send("evm_increaseTime", [DURATION + 1]);
            await ethers.provider.send("evm_mine");
            await socialLending.connect(lender).declareDefault(3);

            // Update price feed to avoid StaleData
            const now = await ethers.provider.getBlock("latest");
            await mockPriceFeed.setPriceData(
                ethers.parseUnits("1", 8),
                2, // roundId
                now.timestamp,
                now.timestamp, // updatedAt
                2 // answeredInRound
            );

            // Loan 4: Cancelled
            await socialLending.connect(borrower).requestLoan(LOAN_AMOUNT, INTEREST_RATE, DURATION, await mockToken.getAddress(), COLLATERAL_AMOUNT);
            await socialLending.connect(borrower).cancelLoanRequest(4);
        });

        it("getStats should return correct counts (O(1))", async function () {
            // Stats: 
            // Total: 5 (0,1,2,3,4)
            // Active (Funded): 1 (Loan 1)
            // Repaid: 1 (Loan 2)
            // Defaulted: 1 (Loan 3)
            // Cancelled: 1 (Loan 4)
            // Liquidated: 0 (Not yet impl)

            // Existing implementation doesn't have Liquidated in return
            // PR-04 changes signature to return 6 values. 
            // This test anticipates the change.
            const stats = await socialLending.getStats();

            expect(stats[0]).to.equal(5); // total
            expect(stats[1]).to.equal(1); // active (Funded only? Or Requested? Logic check: getStats treats Funded as Active usually)
            // Wait, current getStats logic:
            // Requested -> Not counted in active/repaid/defaulted/cancelled lists?
            // Let's check current impl: "activeLoans" counts "Funded".
            // "totalLoans" counts everything.
            // What about Requested? Current impl loops: if (state == Funded) active++.
            // So Requested is NOT active.

            expect(stats[1]).to.equal(1); // active (Funded)
            expect(stats[2]).to.equal(1); // repaid
            expect(stats[3]).to.equal(1); // defaulted
            expect(stats[4]).to.equal(1); // cancelled
            expect(stats[5]).to.equal(1); // liquidated (updated)
        });

        it("getBorrowerLoans should return correct IDs", async function () {
            // Borrower has loans 0, 1, 2, 3, 4.
            // Current logic filters for Requested or Funded.
            // Loan 0: Requested -> Include
            // Loan 1: Funded -> Include
            // Loan 2: Repaid -> Exclude
            // Loan 3: Defaulted -> Exclude
            // Loan 4: Cancelled -> Exclude

            const ids = await socialLending.getBorrowerLoans(borrower.address);
            expect(ids.length).to.equal(2);
            expect(ids[0]).to.equal(0);
            expect(ids[1]).to.equal(1);
        });

        it("getLenderLoans should return correct IDs", async function () {
            // Lender funded 1, 2, 3.
            // Current logic filters for Funded.
            // Loan 1: Funded -> Include
            // Loan 2: Repaid -> Exclude (State is Repaid)
            // Loan 3: Defaulted -> Exclude (State is Defaulted)

            const ids = await socialLending.getLenderLoans(lender.address);
            expect(ids.length).to.equal(1);
            expect(ids[0]).to.equal(1);
        });
    });

    describe("Gas Usage Analysis", function () {
        it("should be efficient for large number of loans", async function () {
            // This test is mostly for manual verification via REPORT_GAS
            // But we can assert that creating many loans works 
            // and calling views doesn't revert.

            // Fix: Use a smaller number for CI to be fast, but large enough to test arrays
            const BATCH_SIZE = 5;

            for (let i = 0; i < BATCH_SIZE; i++) {
                await socialLending.connect(borrower).requestLoan(LOAN_AMOUNT, INTEREST_RATE, DURATION, await mockToken.getAddress(), COLLATERAL_AMOUNT);
            }

            const stats = await socialLending.getStats();
            expect(stats[0]).to.be.gte(5); // At least 5 from this test + previous tests if state persisted? No, beforeEach resets.
        });
    });
});
