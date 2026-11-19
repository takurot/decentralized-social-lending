import { ethers, network } from "hardhat";
import { deployContract } from "./deploy";

export interface E2EReport {
    networkName: string;
    chainId: string;
    contractAddress: string;
    phasesCompleted: number;
    totalAbiFunctions: number;
    calledFunctionCount: number;
    calledFunctions: string[];
    missingFunctions: string[];
    finalState: {
        lockedETH: bigint;
        contractETHBalance: bigint;
        activeLoansCount: bigint;
        totalLoans: bigint;
        repaidLoans: bigint;
        defaultedLoans: bigint;
        cancelledLoans: bigint;
        liquidatedLoans: bigint;
        allTokenLockedCollateralZero: boolean;
        allTokenBalancesZero: boolean;
        statsConsistent: boolean;
        timelockEnabled: boolean;
        ownerAfterRenounce: string;
    };
}

function createTrackedContract<T extends object>(
    contract: T,
    abiFunctionNames: Set<string>,
    calledFunctions: Set<string>
): T {
    return new Proxy(contract, {
        get(target: any, prop: string | symbol, receiver: any) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof prop === "string" && abiFunctionNames.has(prop)) {
                calledFunctions.add(prop);
            }
            if (prop === "connect" && typeof value === "function") {
                return (...args: any[]) => {
                    const connected = value.apply(target, args);
                    return createTrackedContract(connected, abiFunctionNames, calledFunctions);
                };
            }
            if (prop === "interface" && value && typeof value === "object") {
                return new Proxy(value, {
                    get(ifaceTarget: any, ifaceProp: string | symbol, ifaceReceiver: any) {
                        const ifaceVal = Reflect.get(ifaceTarget, ifaceProp, ifaceReceiver);
                        if (ifaceProp === "encodeFunctionData" && typeof ifaceVal === "function") {
                            return (fnName: string, ...rest: any[]) => {
                                if (abiFunctionNames.has(fnName)) {
                                    calledFunctions.add(fnName);
                                }
                                return ifaceVal.apply(ifaceTarget, [fnName, ...rest]);
                            };
                        }
                        return typeof ifaceVal === "function" ? ifaceVal.bind(ifaceTarget) : ifaceVal;
                    },
                });
            }
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

async function advanceTime(seconds: number) {
    await network.provider.send("evm_increaseTime", [seconds]);
    await network.provider.send("evm_mine");
}

export async function runE2EVerification(options: { silent?: boolean } = {}): Promise<E2EReport> {
    const log = (...args: any[]) => {
        if (!options.silent) {
            console.log(...args);
        }
    };

    const [owner, borrower, lender, liquidator, other, newOwner] = await ethers.getSigners();
    const netInfo = await ethers.provider.getNetwork();

    log(`[E2E] Starting 6-phase E2E verification on network="${netInfo.name}" (chainId=${netInfo.chainId})`);

    const rawLending: any = await deployContract(owner.address);
    const lendingAddr = await rawLending.getAddress();

    const abiFunctionNames = new Set<string>();
    for (const fragment of rawLending.interface.fragments) {
        if (fragment.type === "function" && "name" in fragment && typeof fragment.name === "string") {
            abiFunctionNames.add(fragment.name);
        }
    }

    const calledFunctions = new Set<string>();
    const lending: any = createTrackedContract(rawLending, abiFunctionNames, calledFunctions);
    let phasesCompleted = 0;

    // =========================================================================
    // PHASE 1: Admin, Token & Oracle Configuration + Constants & State Getters
    // =========================================================================
    log("[E2E][Phase 1] Configuring tokens, decimals, price feeds, timeouts, and reading constants/getters...");

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token18: any = await MockERC20.deploy("Token18", "T18", 18);
    const token6: any = await MockERC20.deploy("Token6", "T6", 6);
    const token0: any = await MockERC20.deploy("Token0", "T0", 0);
    await token18.waitForDeployment();
    await token6.waitForDeployment();
    await token0.waitForDeployment();

    const MockFeeToken = await ethers.getContractFactory("MockFeeOnTransferERC20");
    const feeToken: any = await MockFeeToken.deploy("FeeToken", "FEE", 500, owner.address); // 5% transfer fee
    await feeToken.waitForDeployment();

    const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed");
    const feed18: any = await MockPriceFeed.deploy();
    const feed6: any = await MockPriceFeed.deploy();
    const feed0: any = await MockPriceFeed.deploy();
    const feedFee: any = await MockPriceFeed.deploy();
    await feed18.waitForDeployment();
    await feed6.waitForDeployment();
    await feed0.waitForDeployment();
    await feedFee.waitForDeployment();

    const refreshAllFeeds = async (priceEth = "2") => {
        const units = ethers.parseUnits(priceEth, 8);
        await feed18.setLatestPrice(units);
        await feed6.setLatestPrice(units);
        await feed0.setLatestPrice(units);
        await feedFee.setLatestPrice(units);
    };
    await refreshAllFeeds("2");

    const MockRevertingReceiver = await ethers.getContractFactory("MockRevertingReceiver");
    const revertingReceiver: any = await MockRevertingReceiver.deploy();
    await revertingReceiver.waitForDeployment();
    const revertingAddr = await revertingReceiver.getAddress();

    const t18Addr = await token18.getAddress();
    const t6Addr = await token6.getAddress();
    const t0Addr = await token0.getAddress();
    const tFeeAddr = await feeToken.getAddress();

    await lending.setCollateralTokenStatus(t18Addr, true);
    await lending.setCollateralTokenStatus(t6Addr, true);
    await lending.setCollateralTokenStatus(t0Addr, true);
    await lending.setCollateralTokenStatus(tFeeAddr, true);

    await lending.setCollateralTokenDecimals(t18Addr, 18);
    await lending.setCollateralTokenDecimals(t6Addr, 6);
    await lending.setCollateralTokenDecimals(t0Addr, 0);
    await lending.setCollateralTokenDecimals(tFeeAddr, 18);

    await lending.setPriceFeed(t18Addr, await feed18.getAddress());
    await lending.setPriceFeed(t6Addr, await feed6.getAddress());
    await lending.setPriceFeed(t0Addr, await feed0.getAddress());
    await lending.setPriceFeed(tFeeAddr, await feedFee.getAddress());

    await lending.setPriceFeedTimeout(t18Addr, 24 * 3600);
    const effTimeout = await lending.getEffectivePriceFeedTimeout(t18Addr);
    if (effTimeout !== 86400n) throw new Error("Unexpected effective timeout");

    await lending.setMaxLoanAmount(ethers.parseEther("20"));
    await lending.setMaxActiveLoansPerBorrower(5);
    await lending.setPlatformFee(100);
    await lending.setFeeRecipient(owner.address);
    await lending.setCollateralRatio(15000);
    await lending.setGracePeriod(3 * 86400);
    await lending.setLiquidationThreshold(12000);

    // Read all public constants and state/mapping getters
    await lending.BASIS_POINTS();
    await lending.MAX_INTEREST_RATE();
    await lending.MAX_PLATFORM_FEE();
    await lending.SECONDS_PER_YEAR();
    await lending.PRICE_FEED_TIMEOUT();
    await lending.MIN_PRICE_FEED_TIMEOUT();
    await lending.MAX_PRICE_FEED_TIMEOUT();
    await lending.ORACLE_FALLBACK_DELAY();
    const reqExpiryWindow = Number(await lending.LOAN_REQUEST_EXPIRATION());
    await lending.MAX_LOAN_DURATION();
    await lending.MAX_GRACE_PERIOD();
    const timelockDelay = Number(await lending.TIMELOCK_DELAY());
    await lending.MIN_COLLATERAL_RATIO();
    await lending.MAX_COLLATERAL_RATIO();

    await lending.owner();
    await lending.paused();
    await lending.timelockEnabled();
    await lending.platformFee();
    await lending.feeRecipient();
    await lending.collateralRatio();
    await lending.gracePeriod();
    await lending.liquidationThreshold();
    await lending.liquidationBonus();
    await lending.maxLoanAmount();
    await lending.maxActiveLoansPerBorrower();
    await lending.allowedCollateralTokens(t18Addr);
    await lending.collateralTokenDecimals(t18Addr);
    await lending.collateralDecimalsSet(t18Addr);
    await lending.priceFeeds(t18Addr);
    await lending.priceFeedTimeouts(t18Addr);
    await lending.lockedCollateral(t18Addr);
    await lending.lockedETH();
    await lending.pendingETHWithdrawals(owner.address);
    await lending.loanCount();
    await lending.offerCount();
    await lending.activeLoansCount();
    await lending.repaidLoansCount();
    await lending.defaultedLoansCount();
    await lending.cancelledLoansCount();
    await lending.liquidatedLoansCount();
    await lending.borrowerActiveLoans(borrower.address);
    await lending.lenderActiveLoans(lender.address);
    await lending.userReputations(borrower.address);

    await token18.mint(borrower.address, ethers.parseUnits("1000", 18));
    await token6.mint(borrower.address, ethers.parseUnits("1000", 6));
    await token0.mint(borrower.address, 1000n);
    await feeToken.mint(borrower.address, ethers.parseUnits("1000", 18));
    await token18.connect(borrower).approve(lendingAddr, ethers.MaxUint256);
    await token6.connect(borrower).approve(lendingAddr, ethers.MaxUint256);
    await token0.connect(borrower).approve(lendingAddr, ethers.MaxUint256);
    await feeToken.connect(borrower).approve(lendingAddr, ethers.MaxUint256);

    phasesCompleted = 1;

    // =========================================================================
    // PHASE 2: Borrower-Initiated Loan Request Lifecycle
    // =========================================================================
    log("[E2E][Phase 2] Running loan request, cancellation, expiration, fee-snapshot funding, and partial/full repayment...");

    // Loan #0: request -> cancel
    await lending.connect(borrower).requestLoan(ethers.parseEther("1"), 500, 7 * 86400, t18Addr, ethers.parseEther("1"));
    await lending.connect(borrower).cancelLoanRequest(0);

    // Loan #1: request -> expire -> cancel
    await lending.connect(borrower).requestLoan(ethers.parseEther("1"), 500, 7 * 86400, t6Addr, ethers.parseUnits("1", 6));
    await advanceTime(reqExpiryWindow + 10);
    await refreshAllFeeds("2");
    await lending.connect(borrower).cancelLoanRequest(1);

    // Loan #2: fee-on-transfer token request -> platformFee hike (snapshot check) -> fund -> views -> partial + full repay
    await lending.connect(borrower).requestLoan(ethers.parseEther("1"), 500, 7 * 86400, tFeeAddr, ethers.parseEther("2"));
    await lending.setPlatformFee(400); // Raise fee after request; Loan #2 keeps 100 bp snapshot
    await lending.connect(lender).fundLoan(2, { value: ethers.parseEther("1") });
    await lending.setPlatformFee(100);

    await lending.getBorrowerLoans(borrower.address);
    await lending.getLenderLoans(lender.address);
    await lending.getCollateralValueInETH(tFeeAddr, ethers.parseEther("1.9"));
    await lending.getCollateralizationRatio(2);
    const loan2 = await lending.loans(2);

    await lending.connect(borrower).repayLoan(2, { value: ethers.parseEther("0.4") });
    await lending.connect(borrower).repayLoan(2, { value: loan2.repaymentAmount }); // Includes excess refund
    await lending.getCreditScore(borrower.address);
    await lending.getStats();

    phasesCompleted = 2;

    // =========================================================================
    // PHASE 3: Lender-Initiated Loan Offer Lifecycle
    // =========================================================================
    log("[E2E][Phase 3] Running loan offer creation, cancellation, expiration, acceptance, and repayment...");

    // Offer #0: create -> cancel
    await lending.connect(lender).createLoanOffer(1000, 86400, 30 * 86400, t18Addr, 15000, {
        value: ethers.parseEther("1"),
    });
    await lending.connect(lender).cancelLoanOffer(0);
    await lending.loanOffers(0);

    // Offer #1: create -> expire
    await lending.connect(lender).createLoanOffer(1000, 86400, 30 * 86400, t18Addr, 15000, {
        value: ethers.parseEther("1"),
    });
    await advanceTime(31 * 86400);
    await refreshAllFeeds("2");
    await lending.connect(other).expireLoanOffer(1);

    // Offer #2: create -> accept (creates Loan #3) -> full repay
    await lending.connect(lender).createLoanOffer(1000, 86400, 30 * 86400, t18Addr, 15000, {
        value: ethers.parseEther("1"),
    });
    await lending.connect(borrower).acceptLoanOffer(2, 500, 7 * 86400, t18Addr, ethers.parseEther("1"));
    const loan3 = await lending.loans(3);
    await lending.connect(borrower).repayLoan(3, { value: loan3.remainingRepaymentAmount });

    phasesCompleted = 3;

    // =========================================================================
    // PHASE 4: Liquidation & Maturity Default (Normal Surplus + Oracle Fallback)
    // =========================================================================
    log("[E2E][Phase 4] Running price-based liquidation, normal surplus defaults, and oracle-outage fallback default...");

    // Loan #4: liquidate on price drop
    await lending.connect(borrower).requestLoan(ethers.parseEther("1"), 500, 7 * 86400, t18Addr, ethers.parseEther("1"));
    await lending.connect(lender).fundLoan(4, { value: ethers.parseEther("1") });
    await feed18.setLatestPrice(ethers.parseUnits("1.1", 8)); // 1.1 ETH < 120% threshold
    const loan4 = await lending.loans(4);
    await lending.connect(liquidator).liquidate(4, { value: loan4.remainingRepaymentAmount + ethers.parseEther("0.05") });
    await refreshAllFeeds("2");

    // Loan #5: declareDefault (0-decimal token round-up seizure)
    await lending.connect(borrower).requestLoan(ethers.parseEther("1"), 500, 7 * 86400, t0Addr, 1n);
    await lending.connect(lender).fundLoan(5, { value: ethers.parseEther("1") });
    await advanceTime(11 * 86400);
    await refreshAllFeeds("2");
    await lending.connect(lender).declareDefault(5);

    // Loan #6: checkAndDeclareDefault (over-collateralized with surplus return)
    await lending.connect(borrower).requestLoan(ethers.parseEther("1"), 500, 7 * 86400, t18Addr, ethers.parseEther("1"));
    await lending.connect(lender).fundLoan(6, { value: ethers.parseEther("1") });
    await advanceTime(11 * 86400);
    await refreshAllFeeds("2");
    await lending.connect(other).checkAndDeclareDefault(6);

    // Loan #7: declareDefault via ORACLE_FALLBACK_DELAY when price feed is stale/dead
    await lending.connect(borrower).requestLoan(ethers.parseEther("1"), 500, 7 * 86400, t6Addr, ethers.parseUnits("1", 6));
    await lending.connect(lender).fundLoan(7, { value: ethers.parseEther("1") });
    const fallbackDelay = Number(await lending.ORACLE_FALLBACK_DELAY());
    await advanceTime(11 * 86400 + fallbackDelay + 10);
    // Do NOT refresh feed6 -> settles via oracle-outage full-seizure fallback
    await lending.connect(lender).declareDefault(7);
    await refreshAllFeeds("2");

    phasesCompleted = 4;

    // =========================================================================
    // PHASE 5: Pull-Payment Queue, Emergency Pause/Unpause & Asset Rescue
    // =========================================================================
    log("[E2E][Phase 5] Running pull-payment withdrawETH/withdrawETHTo, pause-time unwind, and rescueTokens/rescueETH...");

    await revertingReceiver.setShouldRevert(true);
    await lending.setFeeRecipient(revertingAddr);

    // Loan #8 (Funded) and Loan #9 (Requested) created before pause
    await lending.connect(borrower).requestLoan(ethers.parseEther("1"), 500, 7 * 86400, t18Addr, ethers.parseEther("1"));
    await lending.connect(lender).fundLoan(8, { value: ethers.parseEther("1") }); // Fee queued for revertingReceiver
    await lending.connect(borrower).requestLoan(ethers.parseEther("1"), 500, 7 * 86400, t18Addr, ethers.parseEther("1"));

    // Pause protocol: borrower unwinds Funded Loan #8 via repayLoan and Requested Loan #9 via cancelLoanRequest
    await lending.pause();
    const loan8 = await lending.loans(8);
    await lending.connect(borrower).repayLoan(8, { value: loan8.remainingRepaymentAmount });
    await lending.connect(borrower).cancelLoanRequest(9);
    await lending.unpause();

    // Non-payable revertingReceiver withdraws queued fee to `other.address` via withdrawETHTo while shouldRevert == true
    const withdrawToData = lending.interface.encodeFunctionData("withdrawETHTo", [other.address]);
    await revertingReceiver.callContract(lendingAddr, withdrawToData);

    // Queue a second fee via Loan #10, then toggle shouldRevert(false) and call withdrawETH()
    await lending.connect(borrower).requestLoan(ethers.parseEther("1"), 500, 7 * 86400, t18Addr, ethers.parseEther("1"));
    await lending.connect(lender).fundLoan(10, { value: ethers.parseEther("1") });
    const loan10 = await lending.loans(10);
    await lending.connect(borrower).repayLoan(10, { value: loan10.remainingRepaymentAmount });

    await revertingReceiver.setShouldRevert(false);
    const withdrawData = lending.interface.encodeFunctionData("withdrawETH", []);
    await revertingReceiver.callContract(lendingAddr, withdrawData);
    await lending.setFeeRecipient(owner.address);

    // Rescue unlocked donated tokens and force-fed ETH
    const donatedTokens = ethers.parseUnits("5", 18);
    await token18.mint(lendingAddr, donatedTokens);
    await lending.rescueTokens(t18Addr, donatedTokens, owner.address);

    const forceFedETH = ethers.parseEther("0.25");
    const balBefore = await ethers.provider.getBalance(lendingAddr);
    await network.provider.send("hardhat_setBalance", [lendingAddr, ethers.toBeHex(balBefore + forceFedETH)]);
    await lending.rescueETH(forceFedETH, owner.address);

    phasesCompleted = 5;

    // =========================================================================
    // PHASE 6: 48-Hour Timelock Governance & Ownership Lifecycle
    // =========================================================================
    log("[E2E][Phase 6] Running 48-hour timelock queue/cancel/execute and ownership transfer/renounce...");

    await lending.enableTimelock();
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const setFeeSelector = lending.interface.getFunction("setPlatformFee").selector;

    const txCancel = await lending.queueChange(setFeeSelector, abiCoder.encode(["uint256"], [250]));
    const rcCancel = await txCancel.wait();
    const evCancel = rcCancel.logs
        .map((l: any) => {
            try {
                return lending.interface.parseLog(l);
            } catch {
                return null;
            }
        })
        .find((p: any) => p && p.name === "ChangeQueued");
    const cancelHash = evCancel.args.operationHash;
    await lending.pendingChanges(cancelHash);
    await lending.cancelChange(cancelHash);

    await lending.queueChange(setFeeSelector, abiCoder.encode(["uint256"], [200]));
    await advanceTime(timelockDelay + 10);
    await lending.setPlatformFee(200);

    await lending.transferOwnership(newOwner.address);
    await lending.connect(newOwner).renounceOwnership();

    phasesCompleted = 6;

    // =========================================================================
    // FINAL AUDIT: 100% ABI Function Coverage & Accounting Invariants
    // =========================================================================
    const finalStats = await lending.getStats();
    const finalLockedETH = await lending.lockedETH();
    const contractETHBalance = await ethers.provider.getBalance(lendingAddr);

    const tokenList = [token18, token6, token0, feeToken];
    let allTokenLockedCollateralZero = true;
    let allTokenBalancesZero = true;
    for (const tok of tokenList) {
        const addr = await tok.getAddress();
        if ((await lending.lockedCollateral(addr)) !== 0n) {
            allTokenLockedCollateralZero = false;
        }
        if ((await tok.balanceOf(lendingAddr)) !== 0n) {
            allTokenBalancesZero = false;
        }
    }

    const sumTerminal =
        finalStats.repaidLoans +
        finalStats.defaultedLoans +
        finalStats.cancelledLoans +
        finalStats.liquidatedLoans;
    const statsConsistent =
        finalStats.activeLoans === 0n && finalStats.totalLoans === sumTerminal && finalStats.totalLoans === 11n;

    const missingFunctions = Array.from(abiFunctionNames)
        .filter((fn) => !calledFunctions.has(fn))
        .sort();

    const report: E2EReport = {
        networkName: netInfo.name,
        chainId: netInfo.chainId.toString(),
        contractAddress: lendingAddr,
        phasesCompleted,
        totalAbiFunctions: abiFunctionNames.size,
        calledFunctionCount: calledFunctions.size,
        calledFunctions: Array.from(calledFunctions).sort(),
        missingFunctions,
        finalState: {
            lockedETH: finalLockedETH,
            contractETHBalance,
            activeLoansCount: finalStats.activeLoans,
            totalLoans: finalStats.totalLoans,
            repaidLoans: finalStats.repaidLoans,
            defaultedLoans: finalStats.defaultedLoans,
            cancelledLoans: finalStats.cancelledLoans,
            liquidatedLoans: finalStats.liquidatedLoans,
            allTokenLockedCollateralZero,
            allTokenBalancesZero,
            statsConsistent,
            timelockEnabled: await lending.timelockEnabled(),
            ownerAfterRenounce: await lending.owner(),
        },
    };

    log(
        `[E2E] Completed ${report.phasesCompleted}/6 phases. Invoked ${report.calledFunctionCount}/${report.totalAbiFunctions} ABI functions (missing: ${report.missingFunctions.length}).`
    );
    log(
        `[E2E] Final Stats: total=${finalStats.totalLoans}, active=${finalStats.activeLoans}, repaid=${finalStats.repaidLoans}, defaulted=${finalStats.defaultedLoans}, cancelled=${finalStats.cancelledLoans}, liquidated=${finalStats.liquidatedLoans}, lockedETH=${finalLockedETH}, ethBalance=${contractETHBalance}`
    );

    if (report.missingFunctions.length > 0) {
        throw new Error(`E2E ABI function coverage incomplete. Missing: ${report.missingFunctions.join(", ")}`);
    }
    if (
        !allTokenLockedCollateralZero ||
        !allTokenBalancesZero ||
        !statsConsistent ||
        finalLockedETH !== 0n ||
        contractETHBalance !== 0n
    ) {
        throw new Error("E2E final accounting invariant check failed.");
    }

    return report;
}

if (require.main === module) {
    runE2EVerification()
        .then(() => {
            console.log("[E2E] All 6 phases, 100% ABI functions, and accounting invariants verified successfully.");
        })
        .catch((error) => {
            console.error("[E2E] Verification failed:", error);
            process.exitCode = 1;
        });
}
