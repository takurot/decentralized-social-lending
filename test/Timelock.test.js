const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Timelock Governance (Issue #15)", function () {
    let lending;
    let owner, user1, feeRecipient2;
    let mockToken;

    const TIMELOCK_DELAY = 48 * 60 * 60; // 48 hours

    beforeEach(async function () {
        [owner, user1, feeRecipient2] = await ethers.getSigners();

        const MockERC20 = await ethers.getContractFactory("MockERC20");
        mockToken = await MockERC20.deploy("Mock Token", "MTK", 18);
        await mockToken.waitForDeployment();

        const Lending = await ethers.getContractFactory("SocialLendingWithCollateral");
        lending = await Lending.deploy(owner.address);
        await lending.waitForDeployment();
    });

    it("should have TIMELOCK_DELAY = 48 hours and timelockEnabled = true by default", async function () {
        expect(await lending.TIMELOCK_DELAY()).to.equal(TIMELOCK_DELAY);
        expect(await lending.timelockEnabled()).to.equal(true);
    });

    it("should enforce timelock immediately from deployment without calling enableTimelock", async function () {
        await expect(lending.setPlatformFee(200))
            .to.be.revertedWithCustomError(lending, "ChangeNotQueued");
    });

    it("should restrict enableTimelock to owner and revert since timelock is already enabled", async function () {
        await expect(lending.connect(user1).enableTimelock())
            .to.be.revertedWith("Ownable: caller is not the owner");

        await expect(lending.enableTimelock())
            .to.be.revertedWithCustomError(lending, "InvalidParameter");
    });

    describe("When timelock is enabled", function () {
        const abiCoder = ethers.AbiCoder.defaultAbiCoder();

        it("should keep pause and unpause immediate", async function () {
            await lending.pause();
            expect(await lending.paused()).to.equal(true);
            await lending.unpause();
            expect(await lending.paused()).to.equal(false);
        });

        it("should revert unqueued admin calls with ChangeNotQueued", async function () {
            await expect(lending.setPlatformFee(200))
                .to.be.revertedWithCustomError(lending, "ChangeNotQueued");
            await expect(lending.setFeeRecipient(feeRecipient2.address))
                .to.be.revertedWithCustomError(lending, "ChangeNotQueued");
            await expect(lending.setCollateralRatio(16000))
                .to.be.revertedWithCustomError(lending, "ChangeNotQueued");
            await expect(lending.setCollateralTokenStatus(await mockToken.getAddress(), true))
                .to.be.revertedWithCustomError(lending, "ChangeNotQueued");
        });

        it("should validate parameters fail-fast before timelock check", async function () {
            await expect(lending.setPlatformFee(1001))
                .to.be.revertedWithCustomError(lending, "InvalidParameter");
            await expect(lending.setFeeRecipient(ethers.ZeroAddress))
                .to.be.revertedWithCustomError(lending, "InvalidAddress");
            await expect(lending.setCollateralRatio(9999))
                .to.be.revertedWithCustomError(lending, "InvalidParameter");
            await expect(lending.setCollateralTokenStatus(ethers.ZeroAddress, true))
                .to.be.revertedWithCustomError(lending, "InvalidAddress");
        });

        it("should restrict queueChange and cancelChange to owner", async function () {
            const selector = lending.interface.getFunction("setPlatformFee").selector;
            const params = abiCoder.encode(["uint256"], [200]);

            await expect(lending.connect(user1).queueChange(selector, params))
                .to.be.revertedWith("Ownable: caller is not the owner");
            await expect(lending.connect(user1).cancelChange(ethers.ZeroHash))
                .to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("should revert queueChange on zero selector", async function () {
            const params = abiCoder.encode(["uint256"], [200]);
            await expect(lending.queueChange("0x00000000", params))
                .to.be.revertedWithCustomError(lending, "InvalidParameter");
        });

        it("should enforce 48h delay for setPlatformFee and prevent replay", async function () {
            const selector = lending.interface.getFunction("setPlatformFee").selector;
            const params = abiCoder.encode(["uint256"], [250]);

            const tx = await lending.queueChange(selector, params);
            const receipt = await tx.wait();
            const event = receipt.logs.find(
                (log) => log.fragment && log.fragment.name === "ChangeQueued"
            );
            const opHash = event.args.operationHash;

            await expect(lending.setPlatformFee(250))
                .to.be.revertedWithCustomError(lending, "TimelockNotElapsed");

            await time.increase(TIMELOCK_DELAY - 10);
            await expect(lending.setPlatformFee(250))
                .to.be.revertedWithCustomError(lending, "TimelockNotElapsed");

            await time.increase(11);
            await expect(lending.setPlatformFee(250))
                .to.emit(lending, "ChangeExecuted")
                .withArgs(opHash)
                .and.to.emit(lending, "PlatformFeeUpdated")
                .withArgs(250);

            expect(await lending.platformFee()).to.equal(250);

            // Replay should revert with ChangeNotQueued
            await expect(lending.setPlatformFee(250))
                .to.be.revertedWithCustomError(lending, "ChangeNotQueued");

            // Cancelling an already-executed opHash reverts with ChangeAlreadyExecuted
            await expect(lending.cancelChange(opHash))
                .to.be.revertedWithCustomError(lending, "ChangeAlreadyExecuted");
        });

        it("should support timelocked setFeeRecipient, setCollateralRatio, and setCollateralTokenStatus", async function () {
            const tokenAddr = await mockToken.getAddress();

            const selRecip = lending.interface.getFunction("setFeeRecipient").selector;
            const selRatio = lending.interface.getFunction("setCollateralRatio").selector;
            const selToken = lending.interface.getFunction("setCollateralTokenStatus").selector;

            await lending.queueChange(selRecip, abiCoder.encode(["address"], [feeRecipient2.address]));
            await lending.queueChange(selRatio, abiCoder.encode(["uint256"], [17500]));
            await lending.queueChange(selToken, abiCoder.encode(["address", "bool"], [tokenAddr, true]));

            await time.increase(TIMELOCK_DELAY + 1);

            await expect(lending.setFeeRecipient(feeRecipient2.address))
                .to.emit(lending, "FeeRecipientUpdated")
                .withArgs(feeRecipient2.address);
            expect(await lending.feeRecipient()).to.equal(feeRecipient2.address);

            await expect(lending.setCollateralRatio(17500))
                .to.emit(lending, "CollateralRatioUpdated")
                .withArgs(17500);
            expect(await lending.collateralRatio()).to.equal(17500);

            await expect(lending.setCollateralTokenStatus(tokenAddr, true))
                .to.emit(lending, "CollateralTokenStatusUpdated")
                .withArgs(tokenAddr, true);
            expect(await lending.allowedCollateralTokens(tokenAddr)).to.equal(true);
        });

        it("should allow cancelling a queued change and handle overwritten queue entries safely", async function () {
            const selector = lending.interface.getFunction("setPlatformFee").selector;
            const params = abiCoder.encode(["uint256"], [300]);

            // Cancel unknown hash reverts
            await expect(lending.cancelChange(ethers.keccak256(ethers.toUtf8Bytes("none"))))
                .to.be.revertedWithCustomError(lending, "ChangeNotQueued");

            const tx1 = await lending.queueChange(selector, params);
            const r1 = await tx1.wait();
            const opHash1 = r1.logs.find((l) => l.fragment?.name === "ChangeQueued").args.operationHash;

            await expect(lending.cancelChange(opHash1))
                .to.emit(lending, "ChangeCancelled")
                .withArgs(opHash1);

            await time.increase(TIMELOCK_DELAY + 1);
            await expect(lending.setPlatformFee(300))
                .to.be.revertedWithCustomError(lending, "ChangeNotQueued");

            // Queue again with same selector+params; duplicate active queue must revert with ChangeAlreadyQueued
            const tx1b = await lending.queueChange(selector, params);
            const r1b = await tx1b.wait();
            const opHash1b = r1b.logs.find((l) => l.fragment?.name === "ChangeQueued").args.operationHash;

            await expect(lending.queueChange(selector, params))
                .to.be.revertedWithCustomError(lending, "ChangeAlreadyQueued");

            // After cancelling opHash1b, re-queuing succeeds and can be executed
            await lending.cancelChange(opHash1b);
            const tx2 = await lending.queueChange(selector, params);
            const r2 = await tx2.wait();
            const opHash2 = r2.logs.find((l) => l.fragment?.name === "ChangeQueued").args.operationHash;

            await time.increase(TIMELOCK_DELAY + 1);

            await expect(lending.setPlatformFee(300))
                .to.emit(lending, "ChangeExecuted")
                .withArgs(opHash2);
            expect(await lending.platformFee()).to.equal(300);
        });

        it("should revert unqueued setPriceFeed, setCollateralTokenDecimals, setGracePeriod, and setLiquidationThreshold", async function () {
            const tokenAddr = await mockToken.getAddress();
            const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed");
            const deployedFeed = await MockPriceFeed.deploy();
            const feedAddr = await deployedFeed.getAddress();

            await expect(lending.setPriceFeed(tokenAddr, feedAddr))
                .to.be.revertedWithCustomError(lending, "ChangeNotQueued");
            await expect(lending.setCollateralTokenDecimals(tokenAddr, 6))
                .to.be.revertedWithCustomError(lending, "ChangeNotQueued");
            await expect(lending.setGracePeriod(3 * 86400))
                .to.be.revertedWithCustomError(lending, "ChangeNotQueued");
            await expect(lending.setLiquidationThreshold(12500))
                .to.be.revertedWithCustomError(lending, "ChangeNotQueued");
        });

        it("should validate parameters fail-fast before timelock check on newly timelocked setters", async function () {
            const tokenAddr = await mockToken.getAddress();

            await expect(lending.setPriceFeed(ethers.ZeroAddress, user1.address))
                .to.be.revertedWithCustomError(lending, "InvalidAddress");
            await expect(lending.setPriceFeed(tokenAddr, ethers.ZeroAddress))
                .to.be.revertedWithCustomError(lending, "InvalidAddress");
            await expect(lending.setCollateralTokenDecimals(ethers.ZeroAddress, 6))
                .to.be.revertedWithCustomError(lending, "InvalidAddress");
            await expect(lending.setCollateralTokenDecimals(tokenAddr, 19))
                .to.be.revertedWithCustomError(lending, "InvalidParameter");
            await expect(lending.setGracePeriod(31 * 86400))
                .to.be.revertedWithCustomError(lending, "InvalidParameter");
            await expect(lending.setLiquidationThreshold(10500))
                .to.be.revertedWithCustomError(lending, "InvalidParameter");
        });

        it("should support timelocked setPriceFeed, setCollateralTokenDecimals, setGracePeriod, and setLiquidationThreshold", async function () {
            const tokenAddr = await mockToken.getAddress();
            const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed");
            const deployedFeed = await MockPriceFeed.deploy();
            const feedAddr = await deployedFeed.getAddress();

            const selFeed = lending.interface.getFunction("setPriceFeed").selector;
            const selDec = lending.interface.getFunction("setCollateralTokenDecimals").selector;
            const selGrace = lending.interface.getFunction("setGracePeriod").selector;
            const selLiq = lending.interface.getFunction("setLiquidationThreshold").selector;

            await lending.queueChange(selFeed, abiCoder.encode(["address", "address"], [tokenAddr, feedAddr]));
            await lending.queueChange(selDec, abiCoder.encode(["address", "uint8"], [tokenAddr, 6]));
            await lending.queueChange(selGrace, abiCoder.encode(["uint256"], [3 * 86400]));
            await lending.queueChange(selLiq, abiCoder.encode(["uint256"], [12500]));

            await time.increase(TIMELOCK_DELAY + 1);
            await deployedFeed.setLatestPrice(ethers.parseUnits("2", 8));

            await expect(lending.setPriceFeed(tokenAddr, feedAddr))
                .to.emit(lending, "PriceFeedUpdated")
                .withArgs(tokenAddr, feedAddr);
            expect(await lending.priceFeeds(tokenAddr)).to.equal(feedAddr);

            await expect(lending.setCollateralTokenDecimals(tokenAddr, 6))
                .to.emit(lending, "CollateralTokenDecimalsUpdated")
                .withArgs(tokenAddr, 6);
            expect(await lending.collateralTokenDecimals(tokenAddr)).to.equal(6);

            await expect(lending.setGracePeriod(3 * 86400))
                .to.emit(lending, "GracePeriodUpdated")
                .withArgs(3 * 86400);
            expect(await lending.gracePeriod()).to.equal(3 * 86400);

            await expect(lending.setLiquidationThreshold(12500))
                .to.emit(lending, "LiquidationThresholdUpdated")
                .withArgs(12500);
            expect(await lending.liquidationThreshold()).to.equal(12500);
        });

        it("should keep setMaxLoanAmount and setMaxActiveLoansPerBorrower immediate", async function () {
            await expect(lending.setMaxLoanAmount(ethers.parseEther("50")))
                .to.emit(lending, "MaxLoanAmountUpdated")
                .withArgs(ethers.parseEther("50"));
            expect(await lending.maxLoanAmount()).to.equal(ethers.parseEther("50"));

            await expect(lending.setMaxActiveLoansPerBorrower(5))
                .to.emit(lending, "MaxActiveLoansPerBorrowerUpdated")
                .withArgs(5);
            expect(await lending.maxActiveLoansPerBorrower()).to.equal(5);
        });
    });
});
