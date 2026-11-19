const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { execSync } = require("child_process");
const path = require("path");

describe("v1.3.0 Governance, Lifecycle, Scalability, and TypeScript Infra (#44, #55, #56, #66, #67, #68)", function () {
    let lending;
    let mockToken;
    let mockPriceFeed;
    let owner, borrower, lender, keeper, newOwner;
    const TWO_DAYS = 2 * 24 * 60 * 60;
    const FOURTEEN_DAYS = 14 * 24 * 60 * 60;
    const THIRTY_DAYS = 30 * 24 * 60 * 60;

    async function queueAndExecute(contract, fnName, types, values) {
        const selector = contract.interface.getFunction(fnName).selector;
        const params = ethers.AbiCoder.defaultAbiCoder().encode(types, values);
        await contract.queueChange(selector, params);
        await network.provider.send("evm_increaseTime", [TWO_DAYS + 1]);
        await network.provider.send("evm_mine");
        await mockPriceFeed.setLatestPrice(ethers.parseUnits("2000", 8));
        return contract[fnName](...values);
    }

    beforeEach(async function () {
        [owner, borrower, lender, keeper, newOwner] = await ethers.getSigners();

        const MockERC20 = await ethers.getContractFactory("MockERC20");
        mockToken = await MockERC20.deploy("Mock Token", "MTK", 18);

        const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed");
        mockPriceFeed = await MockPriceFeed.deploy();
        await mockPriceFeed.setLatestPrice(ethers.parseUnits("2000", 8));

        const SocialLending = await ethers.getContractFactory("SocialLendingWithCollateral");
        lending = await SocialLending.deploy(owner.address);
    });

    describe("Issue #44 & #67: Timelock enabled by default, Ownable2Step, and disabled renounceOwnership", function () {
        it("should have timelockEnabled == true immediately upon deployment and reject enableTimelock()", async function () {
            expect(await lending.timelockEnabled()).to.equal(true);
            await expect(lending.enableTimelock()).to.be.revertedWithCustomError(lending, "InvalidParameter");
            await expect(lending.connect(borrower).enableTimelock()).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("should enforce timelock on admin setters immediately after deployment without calling enableTimelock()", async function () {
            await expect(lending.setPlatformFee(200)).to.be.revertedWithCustomError(lending, "ChangeNotQueued");
            await expect(
                lending.setCollateralTokenStatus(await mockToken.getAddress(), true)
            ).to.be.revertedWithCustomError(lending, "ChangeNotQueued");
        });

        it("should enforce two-step ownership transfer (Ownable2Step)", async function () {
            await expect(lending.transferOwnership(newOwner.address))
                .to.emit(lending, "OwnershipTransferStarted")
                .withArgs(owner.address, newOwner.address);

            expect(await lending.owner()).to.equal(owner.address);
            expect(await lending.pendingOwner()).to.equal(newOwner.address);

            await expect(lending.connect(borrower).acceptOwnership()).to.be.revertedWith(
                "Ownable2Step: caller is not the new owner"
            );

            await expect(lending.connect(newOwner).acceptOwnership())
                .to.emit(lending, "OwnershipTransferred")
                .withArgs(owner.address, newOwner.address);

            expect(await lending.owner()).to.equal(newOwner.address);
            expect(await lending.pendingOwner()).to.equal(ethers.ZeroAddress);
        });

        it("should disable renounceOwnership() for owner and non-owner (#67)", async function () {
            await expect(lending.connect(borrower).renounceOwnership()).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
            await expect(lending.renounceOwnership()).to.be.revertedWithCustomError(lending, "InvalidParameter");
            expect(await lending.owner()).to.equal(owner.address);
        });
    });

    describe("Issue #55: Timelock grace window, selector validation, and duplicate-queue protection", function () {
        it("should expose TIMELOCK_GRACE_PERIOD == 14 days", async function () {
            expect(await lending.TIMELOCK_GRACE_PERIOD()).to.equal(BigInt(FOURTEEN_DAYS));
        });

        it("should reject non-timelocked or unknown selectors in queueChange", async function () {
            const pauseSelector = lending.interface.getFunction("pause").selector;
            const maxLoanSelector = lending.interface.getFunction("setMaxLoanAmount").selector;
            const encodedUint = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [100]);

            await expect(lending.queueChange("0x00000000", "0x")).to.be.revertedWithCustomError(
                lending,
                "InvalidParameter"
            );
            await expect(lending.queueChange(pauseSelector, "0x")).to.be.revertedWithCustomError(
                lending,
                "InvalidParameter"
            );
            await expect(lending.queueChange(maxLoanSelector, encodedUint)).to.be.revertedWithCustomError(
                lending,
                "InvalidParameter"
            );
            await expect(lending.queueChange("0x12345678", encodedUint)).to.be.revertedWithCustomError(
                lending,
                "InvalidParameter"
            );
        });

        it("should reject duplicate queueChange while an identical operation is active and pending", async function () {
            const selector = lending.interface.getFunction("setPlatformFee").selector;
            const params = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [250]);

            await lending.queueChange(selector, params);
            await expect(lending.queueChange(selector, params)).to.be.revertedWithCustomError(
                lending,
                "ChangeAlreadyQueued"
            );
        });

        it("should expire queued changes after executeAfter + TIMELOCK_GRACE_PERIOD and allow re-queuing after expiry", async function () {
            const selector = lending.interface.getFunction("setPlatformFee").selector;
            const params = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [300]);

            const tx1 = await lending.queueChange(selector, params);
            const receipt1 = await tx1.wait();
            const event1 = receipt1.logs.find((l) => l.fragment && l.fragment.name === "ChangeQueued");
            const firstHash = event1.args[0];

            // Advance past 2 days + 14 days grace period
            await network.provider.send("evm_increaseTime", [TWO_DAYS + FOURTEEN_DAYS + 2]);
            await network.provider.send("evm_mine");

            await expect(lending.setPlatformFee(300)).to.be.revertedWithCustomError(lending, "ChangeExpired");

            // Re-queuing the same operation after expiry succeeds and cleans up the old entry
            await lending.queueChange(selector, params);
            const oldChange = await lending.pendingChanges(firstHash);
            expect(oldChange.executeAfter).to.equal(0n);

            await network.provider.send("evm_increaseTime", [TWO_DAYS + 1]);
            await network.provider.send("evm_mine");
            await expect(lending.setPlatformFee(300)).to.emit(lending, "PlatformFeeUpdated").withArgs(300);
        });
    });

    describe("Issue #66: Permissionless expireLoanRequest() and active borrower loan filtering", function () {
        beforeEach(async function () {
            const tokenAddr = await mockToken.getAddress();
            const feedAddr = await mockPriceFeed.getAddress();
            await queueAndExecute(lending, "setCollateralTokenStatus", ["address", "bool"], [tokenAddr, true]);
            await queueAndExecute(lending, "setCollateralTokenDecimals", ["address", "uint8"], [tokenAddr, 18]);
            await queueAndExecute(lending, "setPriceFeed", ["address", "address"], [tokenAddr, feedAddr]);

            await mockToken.mint(borrower.address, ethers.parseEther("10"));
            await mockToken.connect(borrower).approve(await lending.getAddress(), ethers.parseEther("10"));
        });

        it("should exclude expired Requested loans from getBorrowerLoans and allow permissionless expireLoanRequest (even while paused)", async function () {
            const tokenAddr = await mockToken.getAddress();
            const collateralAmount = ethers.parseEther("1");
            await lending
                .connect(borrower)
                .requestLoan(ethers.parseEther("1"), 500, 30 * 24 * 3600, tokenAddr, collateralAmount);

            // Before expiry: active in getBorrowerLoans, cannot expireLoanRequest
            expect(await lending.getBorrowerLoans(borrower.address)).to.deep.equal([0n]);
            await expect(lending.connect(keeper).expireLoanRequest(0)).to.be.revertedWithCustomError(
                lending,
                "LoanNotExpired"
            );

            // Advance past 30-day LOAN_REQUEST_EXPIRATION
            await network.provider.send("evm_increaseTime", [THIRTY_DAYS + 2]);
            await network.provider.send("evm_mine");

            // Even before expireLoanRequest is called, getBorrowerLoans excludes the expired request
            expect(await lending.getBorrowerLoans(borrower.address)).to.deep.equal([]);

            // Pause contract to verify expireLoanRequest works while paused
            await lending.pause();
            const balBefore = await mockToken.balanceOf(borrower.address);

            await expect(lending.connect(keeper).expireLoanRequest(0))
                .to.emit(lending, "LoanCancelled")
                .withArgs(0, borrower.address);

            const balAfter = await mockToken.balanceOf(borrower.address);
            expect(balAfter - balBefore).to.equal(collateralAmount);
            expect(await lending.borrowerActiveLoans(borrower.address)).to.equal(0n);
            expect(await lending.lockedCollateral(tokenAddr)).to.equal(0n);

            const loan = await lending.loans(0);
            expect(loan.state).to.equal(4n); // LoanState.Cancelled

            // Calling expireLoanRequest again on a Cancelled loan reverts with InvalidLoanState
            await expect(lending.connect(keeper).expireLoanRequest(0)).to.be.revertedWithCustomError(
                lending,
                "InvalidLoanState"
            );
        });
    });

    describe("Issue #56: Paginated loan and offer getters", function () {
        beforeEach(async function () {
            const tokenAddr = await mockToken.getAddress();
            const feedAddr = await mockPriceFeed.getAddress();
            await queueAndExecute(lending, "setCollateralTokenStatus", ["address", "bool"], [tokenAddr, true]);
            await queueAndExecute(lending, "setCollateralTokenDecimals", ["address", "uint8"], [tokenAddr, 18]);
            await queueAndExecute(lending, "setPriceFeed", ["address", "address"], [tokenAddr, feedAddr]);

            await mockToken.mint(borrower.address, ethers.parseEther("20"));
            await mockToken.connect(borrower).approve(await lending.getAddress(), ethers.parseEther("20"));
        });

        it("should paginate borrower loans, lender loans, and loan offers with edge cases", async function () {
            const tokenAddr = await mockToken.getAddress();
            for (let i = 0; i < 3; i++) {
                await lending
                    .connect(borrower)
                    .requestLoan(ethers.parseEther("0.5"), 500, 30 * 24 * 3600, tokenAddr, ethers.parseEther("0.5"));
                await lending.connect(lender).fundLoan(i, { value: ethers.parseEther("0.5") });
                await lending
                    .connect(lender)
                    .createLoanOffer(500, 86400, 30 * 86400, tokenAddr, 15000, { value: ethers.parseEther("0.5") });
            }

            // Borrower loans pagination
            const [bPage1, bTotal] = await lending.getBorrowerLoansPaginated(borrower.address, 0, 2);
            expect(bTotal).to.equal(3n);
            expect(bPage1).to.deep.equal([0n, 1n]);

            const [bPage2] = await lending.getBorrowerLoansPaginated(borrower.address, 2, 2);
            expect(bPage2).to.deep.equal([2n]);

            const [bEmptyOffset] = await lending.getBorrowerLoansPaginated(borrower.address, 5, 2);
            expect(bEmptyOffset).to.deep.equal([]);

            const [bZeroLimit] = await lending.getBorrowerLoansPaginated(borrower.address, 0, 0);
            expect(bZeroLimit).to.deep.equal([]);

            // Lender loans pagination
            const [lPage1, lTotal] = await lending.getLenderLoansPaginated(lender.address, 1, 2);
            expect(lTotal).to.equal(3n);
            expect(lPage1).to.deep.equal([1n, 2n]);

            // Loan offers pagination
            const [oPage1, oTotal] = await lending.getLoanOffersPaginated(0, 2);
            expect(oTotal).to.equal(3n);
            expect(oPage1).to.deep.equal([0n, 1n]);

            const [oPage2] = await lending.getLoanOffersPaginated(2, 5);
            expect(oPage2).to.deep.equal([2n]);

            const [oEmpty] = await lending.getLoanOffersPaginated(10, 2);
            expect(oEmpty).to.deep.equal([]);

            const [oZeroLimit] = await lending.getLoanOffersPaginated(0, 0);
            expect(oZeroLimit).to.deep.equal([]);
        });
    });

    describe("Issue #68: Direct ts-node/register execution on Node 22", function () {
        it("should load hardhat and TypeScript scripts directly via node -r ts-node/register", function () {
            const repoRoot = path.resolve(__dirname, "..");
            const out = execSync('node -r ts-node/register -e \'require("hardhat"); require("./scripts/deploy.ts"); console.log("TS_NODE_OK")\'', {
                cwd: repoRoot,
                encoding: "utf8",
            });
            expect(out).to.include("TS_NODE_OK");
        });
    });
});
