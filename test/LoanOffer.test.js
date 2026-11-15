const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Loan Offers (PR-08)", function () {
    let socialLending;
    let owner, feeRecipient, borrower, lender, other, mockToken, mockPriceFeed;
    const OFFER_AMOUNT = ethers.parseEther("1");
    const MAX_RATE = 1000; // 10%
    const MIN_DUR = 7 * 86400;
    const MAX_DUR = 60 * 86400;
    const MIN_COLLAT_RATIO = 15000;

    beforeEach(async function () {
        [owner, feeRecipient, borrower, lender, other] = await ethers.getSigners();

        const MockToken = await ethers.getContractFactory("MockERC20");
        mockToken = await MockToken.deploy("Mock", "MOCK", 18);

        const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed");
        mockPriceFeed = await MockPriceFeed.deploy();
        await mockPriceFeed.setLatestPrice(ethers.parseUnits("1", 8)); // 1 token = 1 ETH

        const SocialLending = await ethers.getContractFactory("SocialLendingWithCollateral");
        socialLending = await SocialLending.deploy(feeRecipient.address);

        await socialLending.setCollateralTokenStatus(await mockToken.getAddress(), true);
        await socialLending.setCollateralTokenDecimals(await mockToken.getAddress(), 18);
        await socialLending.setPriceFeed(await mockToken.getAddress(), await mockPriceFeed.getAddress());

        await mockToken.mint(borrower.address, ethers.parseEther("100"));
        await mockToken.connect(borrower).approve(await socialLending.getAddress(), ethers.parseEther("100"));
    });

    it("should create a loan offer and protect lockedETH from rescueETH", async function () {
        await expect(
            socialLending.connect(lender).createLoanOffer(
                MAX_RATE,
                MIN_DUR,
                MAX_DUR,
                await mockToken.getAddress(),
                MIN_COLLAT_RATIO,
                { value: OFFER_AMOUNT }
            )
        )
            .to.emit(socialLending, "LoanOfferCreated")
            .withArgs(0, lender.address, OFFER_AMOUNT, MAX_RATE);

        expect(await socialLending.offerCount()).to.equal(1);
        expect(await socialLending.lockedETH()).to.equal(OFFER_AMOUNT);

        // rescueETH cannot withdraw offer ETH
        await expect(
            socialLending.connect(owner).rescueETH(OFFER_AMOUNT, owner.address)
        ).to.be.revertedWithCustomError(socialLending, "InsufficientUnlockedETH");
    });

    it("should reject invalid parameters in createLoanOffer", async function () {
        const tokenAddr = await mockToken.getAddress();
        await expect(
            socialLending.connect(lender).createLoanOffer(MAX_RATE, MIN_DUR, MAX_DUR, tokenAddr, MIN_COLLAT_RATIO, { value: 0 })
        ).to.be.revertedWithCustomError(socialLending, "InvalidAmount");

        await expect(
            socialLending.connect(lender).createLoanOffer(MAX_RATE, MIN_DUR, MAX_DUR, tokenAddr, MIN_COLLAT_RATIO, {
                value: ethers.parseEther("11"),
            })
        ).to.be.revertedWithCustomError(socialLending, "LoanTooLarge");

        await expect(
            socialLending.connect(lender).createLoanOffer(0, MIN_DUR, MAX_DUR, tokenAddr, MIN_COLLAT_RATIO, { value: OFFER_AMOUNT })
        ).to.be.revertedWithCustomError(socialLending, "InvalidInterestRate");

        await expect(
            socialLending.connect(lender).createLoanOffer(2001, MIN_DUR, MAX_DUR, tokenAddr, MIN_COLLAT_RATIO, { value: OFFER_AMOUNT })
        ).to.be.revertedWithCustomError(socialLending, "InvalidInterestRate");

        await expect(
            socialLending.connect(lender).createLoanOffer(MAX_RATE, 0, MAX_DUR, tokenAddr, MIN_COLLAT_RATIO, { value: OFFER_AMOUNT })
        ).to.be.revertedWithCustomError(socialLending, "InvalidDuration");

        await expect(
            socialLending.connect(lender).createLoanOffer(MAX_RATE, MAX_DUR + 1, MAX_DUR, tokenAddr, MIN_COLLAT_RATIO, { value: OFFER_AMOUNT })
        ).to.be.revertedWithCustomError(socialLending, "InvalidDuration");

        await expect(
            socialLending.connect(lender).createLoanOffer(MAX_RATE, MIN_DUR, 366 * 86400, tokenAddr, MIN_COLLAT_RATIO, { value: OFFER_AMOUNT })
        ).to.be.revertedWithCustomError(socialLending, "InvalidDuration");

        await expect(
            socialLending.connect(lender).createLoanOffer(MAX_RATE, MIN_DUR, MAX_DUR, tokenAddr, 9000, { value: OFFER_AMOUNT })
        ).to.be.revertedWithCustomError(socialLending, "InvalidParameter");

        await expect(
            socialLending.connect(lender).createLoanOffer(MAX_RATE, MIN_DUR, MAX_DUR, other.address, MIN_COLLAT_RATIO, { value: OFFER_AMOUNT })
        ).to.be.revertedWithCustomError(socialLending, "TokenNotAllowed");
    });

    it("should allow borrower to accept offer, create Funded loan, deduct fee, and update indexes", async function () {
        // Offer with address(0) (any allowed token) and higher minCollateralRatio (18000 = 180%)
        await socialLending.connect(lender).createLoanOffer(
            MAX_RATE,
            MIN_DUR,
            MAX_DUR,
            ethers.ZeroAddress,
            18000,
            { value: OFFER_AMOUNT }
        );

        const tokenAddr = await mockToken.getAddress();
        // 1.6 ETH collateral is >= global 150% but < offer's 180% -> should revert
        await expect(
            socialLending.connect(borrower).acceptLoanOffer(0, 800, 30 * 86400, tokenAddr, ethers.parseEther("1.6"))
        ).to.be.revertedWithCustomError(socialLending, "InsufficientCollateralValue");

        // Self-funding must revert
        await expect(
            socialLending.connect(lender).acceptLoanOffer(0, 800, 30 * 86400, tokenAddr, ethers.parseEther("2"))
        ).to.be.revertedWithCustomError(socialLending, "SelfFunding");

        const feeBefore = await ethers.provider.getBalance(feeRecipient.address);
        const expectedFee = (OFFER_AMOUNT * 100n) / 10000n;

        await expect(
            socialLending.connect(borrower).acceptLoanOffer(0, 800, 30 * 86400, tokenAddr, ethers.parseEther("2"))
        )
            .to.emit(socialLending, "LoanOfferAccepted")
            .withArgs(0, 0, borrower.address);

        const feeAfter = await ethers.provider.getBalance(feeRecipient.address);
        expect(feeAfter - feeBefore).to.equal(expectedFee);

        const loan = await socialLending.loans(0);
        expect(loan.state).to.equal(1); // Funded
        expect(loan.lender).to.equal(lender.address);
        expect(loan.borrower).to.equal(borrower.address);
        expect(await socialLending.lockedETH()).to.equal(0);
        expect(await socialLending.lockedCollateral(tokenAddr)).to.equal(ethers.parseEther("2"));
        expect(await socialLending.getBorrowerLoans(borrower.address)).to.deep.equal([0n]);
        expect(await socialLending.getLenderLoans(lender.address)).to.deep.equal([0n]);

        // Re-accepting accepted offer must revert
        await expect(
            socialLending.connect(borrower).acceptLoanOffer(0, 800, 30 * 86400, tokenAddr, ethers.parseEther("2"))
        ).to.be.revertedWithCustomError(socialLending, "InvalidLoanState");
    });

    it("should allow lender to cancel offer and reject non-lender or invalid offerId", async function () {
        await expect(socialLending.connect(lender).cancelLoanOffer(0))
            .to.be.revertedWithCustomError(socialLending, "InvalidOfferId");

        await socialLending.connect(lender).createLoanOffer(
            MAX_RATE,
            MIN_DUR,
            MAX_DUR,
            await mockToken.getAddress(),
            MIN_COLLAT_RATIO,
            { value: OFFER_AMOUNT }
        );

        await expect(socialLending.connect(other).cancelLoanOffer(0))
            .to.be.revertedWithCustomError(socialLending, "Unauthorized");

        await expect(socialLending.connect(lender).cancelLoanOffer(0))
            .to.emit(socialLending, "LoanOfferCancelled")
            .withArgs(0);

        expect(await socialLending.lockedETH()).to.equal(0);
        const offer = await socialLending.loanOffers(0);
        expect(offer.state).to.equal(2); // Cancelled
    });

    it("should expire offer after 30 days and reject accept after expiry or expire before expiry", async function () {
        await socialLending.connect(lender).createLoanOffer(
            MAX_RATE,
            MIN_DUR,
            MAX_DUR,
            await mockToken.getAddress(),
            MIN_COLLAT_RATIO,
            { value: OFFER_AMOUNT }
        );

        await expect(socialLending.connect(other).expireLoanOffer(0))
            .to.be.revertedWithCustomError(socialLending, "OfferNotExpired");

        await ethers.provider.send("evm_increaseTime", [30 * 86400 + 1]);
        await ethers.provider.send("evm_mine");

        await expect(
            socialLending.connect(borrower).acceptLoanOffer(0, 800, 30 * 86400, await mockToken.getAddress(), ethers.parseEther("2"))
        ).to.be.revertedWithCustomError(socialLending, "OfferExpired");

        await expect(socialLending.connect(other).expireLoanOffer(0))
            .to.emit(socialLending, "LoanOfferExpired")
            .withArgs(0);

        expect(await socialLending.lockedETH()).to.equal(0);
        const offer = await socialLending.loanOffers(0);
        expect(offer.state).to.equal(3); // Expired
    });
});
