const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SocialLendingWithCollateral", function () {
    let LendingContract, lendingContract;
    let owner, borrower, lender, feeRecipient;
    let collateralToken;
    const loanAmount = ethers.utils.parseEther("1"); // 1 ETH
    const interestRate = 500; // 5%
    const duration = 86400; // 1 day in seconds
    const collateralAmount = ethers.utils.parseEther("2"); // 2 collateral tokens

    before(async () => {
        [owner, borrower, lender, feeRecipient] = await ethers.getSigners();

        // Deploy an ERC20 token to use as collateral
        const CollateralToken = await ethers.getContractFactory("MockERC20");
        collateralToken = await CollateralToken.deploy("CollateralToken", "CT", ethers.utils.parseEther("1000"));
        await collateralToken.deployed();

        // Deploy the lending contract
        LendingContract = await ethers.getContractFactory("SocialLendingWithCollateral");
        lendingContract = await LendingContract.deploy(feeRecipient.address);
        await lendingContract.deployed();
    });

    it("should allow borrower to request a loan", async function () {
        await collateralToken.connect(borrower).approve(lendingContract.address, collateralAmount);
        
        await expect(
            lendingContract.connect(borrower).requestLoan(
                loanAmount,
                interestRate,
                duration,
                collateralToken.address,
                collateralAmount
            )
        ).to.emit(lendingContract, "LoanRequested");

        const loan = await lendingContract.loans(0);
        expect(loan.borrower).to.equal(borrower.address);
        expect(loan.amount).to.equal(loanAmount);
        expect(loan.interestRate).to.equal(interestRate);
        expect(loan.duration).to.equal(duration);
        expect(loan.collateralToken).to.equal(collateralToken.address);
        expect(loan.collateralAmount).to.equal(collateralAmount);
    });

    it("should allow lender to fund the loan", async function () {
        await expect(
            lendingContract.connect(lender).fundLoan(0, { value: loanAmount })
        ).to.emit(lendingContract, "LoanFunded");

        const loan = await lendingContract.loans(0);
        expect(loan.lender).to.equal(lender.address);
        expect(await ethers.provider.getBalance(borrower.address)).to.be.above(loanAmount);
    });

    it("should allow borrower to repay the loan", async function () {
        const repaymentAmount = loanAmount.add(loanAmount.mul(interestRate).div(10000));
        
        await expect(
            lendingContract.connect(borrower).repayLoan(0, { value: repaymentAmount })
        ).to.emit(lendingContract, "LoanRepaid");

        const loan = await lendingContract.loans(0);
        expect(loan.isRepaid).to.equal(true);
        expect(await collateralToken.balanceOf(borrower.address)).to.be.above(collateralAmount);
    });

    it("should handle partial repayment", async function () {
        await collateralToken.connect(borrower).approve(lendingContract.address, collateralAmount);
        await lendingContract.connect(borrower).requestLoan(
            loanAmount,
            interestRate,
            duration,
            collateralToken.address,
            collateralAmount
        );

        await lendingContract.connect(lender).fundLoan(1, { value: loanAmount });
        const partialRepayment = loanAmount.div(2);

        await expect(
            lendingContract.connect(borrower).repayLoan(1, { value: partialRepayment })
        ).to.emit(lendingContract, "LoanPartiallyRepaid");

        const loan = await lendingContract.loans(1);
        expect(loan.remainingRepaymentAmount).to.equal(partialRepayment);
    });

    it("should allow lender to declare default after duration", async function () {
        const loanId = 2;
        await collateralToken.connect(borrower).approve(lendingContract.address, collateralAmount);
        await lendingContract.connect(borrower).requestLoan(
            loanAmount,
            interestRate,
            duration,
            collateralToken.address,
            collateralAmount
        );

        await lendingContract.connect(lender).fundLoan(loanId, { value: loanAmount });
        
        // Fast-forward time past the loan duration
        await ethers.provider.send("evm_increaseTime", [duration + 1]);
        await ethers.provider.send("evm_mine");

        await expect(
            lendingContract.connect(lender).declareDefault(loanId)
        ).to.emit(lendingContract, "DefaultDeclared");

        const loan = await lendingContract.loans(loanId);
        expect(loan.isRepaid).to.equal(true);
        expect(await collateralToken.balanceOf(lender.address)).to.equal(collateralAmount);
    });
});
