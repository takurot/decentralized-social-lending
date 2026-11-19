const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Stateful Protocol Accounting Invariants (Issue #57)", function () {
    // Deterministic xorshift32 PRNG for reproducible multi-actor state-machine fuzzing
    function createRng(seed) {
        let state = seed >>> 0;
        return {
            nextUint32() {
                state ^= state << 13;
                state ^= state >>> 17;
                state ^= state << 5;
                return (state = state >>> 0);
            },
            nextInt(maxExclusive) {
                return this.nextUint32() % maxExclusive;
            },
            pick(arr) {
                return arr[this.nextInt(arr.length)];
            },
        };
    }

    async function assertProtocolInvariants(lending, tokens, trackedAddresses) {
        const lendingAddr = await lending.getAddress();
        const loanCount = Number(await lending.loanCount());
        const offerCount = Number(await lending.offerCount());

        const expectedLockedCollateral = new Map();
        for (const t of tokens) {
            expectedLockedCollateral.set(await t.getAddress(), 0n);
        }

        const countsByState = [0, 0, 0, 0, 0, 0]; // Requested, Funded, Repaid, Defaulted, Cancelled, Liquidated
        const expectedBorrowerActive = new Map();
        const expectedLenderActive = new Map();
        for (const addr of trackedAddresses) {
            expectedBorrowerActive.set(addr, 0n);
            expectedLenderActive.set(addr, 0n);
        }

        for (let i = 0; i < loanCount; i++) {
            const loan = await lending.loans(i);
            const state = Number(loan.state);
            countsByState[state]++;

            if (state === 0 || state === 1) {
                // Requested (0) or Funded (1) locks collateral and counts toward borrowerActiveLoans
                const prev = expectedLockedCollateral.get(loan.collateralToken) || 0n;
                expectedLockedCollateral.set(loan.collateralToken, prev + loan.collateralAmount);

                expectedBorrowerActive.set(
                    loan.borrower,
                    (expectedBorrowerActive.get(loan.borrower) || 0n) + 1n
                );
            }
            if (state === 1) {
                // Funded (1) counts toward lenderActiveLoans and must have remainingRepaymentAmount > 0
                expectedLenderActive.set(
                    loan.lender,
                    (expectedLenderActive.get(loan.lender) || 0n) + 1n
                );
                expect(loan.remainingRepaymentAmount).to.be.greaterThan(0n);
            } else if (state === 2 || state === 3 || state === 5) {
                // Repaid, Defaulted, Liquidated must have zero remainingRepaymentAmount
                expect(loan.remainingRepaymentAmount).to.equal(0n);
            }
        }

        // Invariant 1: ERC-20 balance >= lockedCollateral == sum(Requested + Funded loan collateral)
        for (const t of tokens) {
            const tokenAddr = await t.getAddress();
            const onChainLocked = await lending.lockedCollateral(tokenAddr);
            const actualBalance = await t.balanceOf(lendingAddr);
            const expectedLocked = expectedLockedCollateral.get(tokenAddr);

            expect(onChainLocked).to.equal(expectedLocked);
            expect(actualBalance).to.be.at.least(onChainLocked);
        }

        // Invariant 2: Contract ETH balance >= lockedETH == sum(Created offers) + sum(pendingETHWithdrawals)
        let expectedLockedETH = 0n;
        for (let j = 0; j < offerCount; j++) {
            const offer = await lending.loanOffers(j);
            if (Number(offer.state) === 0) {
                // OfferState.Created
                expectedLockedETH += offer.principalAmount;
            }
        }
        for (const addr of trackedAddresses) {
            expectedLockedETH += await lending.pendingETHWithdrawals(addr);
        }

        const onChainLockedETH = await lending.lockedETH();
        const contractETHBalance = await ethers.provider.getBalance(lendingAddr);
        expect(onChainLockedETH).to.equal(expectedLockedETH);
        expect(contractETHBalance).to.be.at.least(onChainLockedETH);

        // Invariant 3: Global loan statistics counters match exact state partition
        const stats = await lending.getStats();
        expect(stats.totalLoans).to.equal(BigInt(loanCount));
        expect(stats.activeLoans).to.equal(BigInt(countsByState[1]));
        expect(stats.repaidLoans).to.equal(BigInt(countsByState[2]));
        expect(stats.defaultedLoans).to.equal(BigInt(countsByState[3]));
        expect(stats.cancelledLoans).to.equal(BigInt(countsByState[4]));
        expect(stats.liquidatedLoans).to.equal(BigInt(countsByState[5]));
        expect(
            BigInt(
                countsByState[0] +
                    countsByState[1] +
                    countsByState[2] +
                    countsByState[3] +
                    countsByState[4] +
                    countsByState[5]
            )
        ).to.equal(BigInt(loanCount));

        // Invariant 4: Per-user active loan counters and active loan ID views match state
        for (const addr of trackedAddresses) {
            expect(await lending.borrowerActiveLoans(addr)).to.equal(expectedBorrowerActive.get(addr));
            expect(await lending.lenderActiveLoans(addr)).to.equal(expectedLenderActive.get(addr));

            const borrowerLoanIds = await lending.getBorrowerLoans(addr);
            expect(BigInt(borrowerLoanIds.length)).to.equal(expectedBorrowerActive.get(addr));

            const lenderLoanIds = await lending.getLenderLoans(addr);
            expect(BigInt(lenderLoanIds.length)).to.equal(expectedLenderActive.get(addr));
        }
    }

    for (const seed of [101, 202, 303]) {
        it(`should preserve all collateral, ETH, and loan counter invariants across randomized sequence (seed=${seed})`, async function () {
            const [owner, user1, user2, user3, liquidator] = await ethers.getSigners();
            const borrowers = [user1, user2, user3];
            const lenders = [user1, user2, user3];

            const MockERC20 = await ethers.getContractFactory("MockERC20");
            const token18 = await MockERC20.deploy("Token18", "T18", 18);
            const token6 = await MockERC20.deploy("Token6", "T6", 6);
            await token18.waitForDeployment();
            await token6.waitForDeployment();
            const tokens = [token18, token6];

            const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed");
            const feed18 = await MockPriceFeed.deploy();
            const feed6 = await MockPriceFeed.deploy();
            await feed18.waitForDeployment();
            await feed6.waitForDeployment();

            await feed18.setLatestPrice(ethers.parseUnits("2", 8)); // 1 T18 = 2 ETH
            await feed6.setLatestPrice(ethers.parseUnits("2", 8)); // 1 T6 = 2 ETH

            const MockRevertingReceiver = await ethers.getContractFactory("MockRevertingReceiver");
            const revertingFeeRecipient = await MockRevertingReceiver.deploy();
            await revertingFeeRecipient.waitForDeployment();
            const revertingAddr = await revertingFeeRecipient.getAddress();

            const Lending = await ethers.getContractFactory("SocialLendingWithCollateral");
            const lending = await Lending.deploy(owner.address);
            await lending.waitForDeployment();
            const lendingAddr = await lending.getAddress();

            const t18Addr = await token18.getAddress();
            const t6Addr = await token6.getAddress();
            await lending.setCollateralTokenStatus(t18Addr, true);
            await lending.setCollateralTokenStatus(t6Addr, true);
            await lending.setPriceFeed(t18Addr, await feed18.getAddress());
            await lending.setPriceFeed(t6Addr, await feed6.getAddress());
            await lending.setMaxActiveLoansPerBorrower(5);

            for (const u of [user1, user2, user3, liquidator]) {
                await token18.mint(u.address, ethers.parseUnits("10000", 18));
                await token18.connect(u).approve(lendingAddr, ethers.MaxUint256);
                await token6.mint(u.address, ethers.parseUnits("10000", 6));
                await token6.connect(u).approve(lendingAddr, ethers.MaxUint256);
            }

            const trackedAddresses = [
                owner.address,
                user1.address,
                user2.address,
                user3.address,
                liquidator.address,
                revertingAddr,
            ];

            const rng = createRng(seed);
            const STEPS = 35;

            for (let step = 0; step < STEPS; step++) {
                // Keep price feeds fresh on every step
                const priceUnits = rng.nextInt(5) === 0 ? "1" : "2"; // Occasional price dip to trigger liquidations
                await feed18.setLatestPrice(ethers.parseUnits(priceUnits, 8));
                await feed6.setLatestPrice(ethers.parseUnits(priceUnits, 8));

                const action = rng.nextInt(12);
                const loanCount = Number(await lending.loanCount());
                const offerCount = Number(await lending.offerCount());

                try {
                    if (action === 0) {
                        // requestLoan
                        const b = rng.pick(borrowers);
                        const useT6 = rng.nextInt(2) === 1;
                        const tAddr = useT6 ? t6Addr : t18Addr;
                        const principal = ethers.parseEther(rng.nextInt(2) === 0 ? "0.5" : "1.0");
                        const collateral = useT6
                            ? ethers.parseUnits("2", 6)
                            : ethers.parseUnits("2", 18);
                        await lending
                            .connect(b)
                            .requestLoan(principal, 500 + rng.nextInt(1000), 7 * 86400, tAddr, collateral);
                    } else if (action === 1 && loanCount > 0) {
                        // cancelLoanRequest
                        const loanId = rng.nextInt(loanCount);
                        const loan = await lending.loans(loanId);
                        const signer = borrowers.find((u) => u.address === loan.borrower) || user1;
                        await lending.connect(signer).cancelLoanRequest(loanId);
                    } else if (action === 2 && loanCount > 0) {
                        // fundLoan (occasionally with reverting feeRecipient to exercise pull-payment queue)
                        if (rng.nextInt(3) === 0) {
                            await revertingFeeRecipient.setShouldRevert(true);
                            await lending.setFeeRecipient(revertingAddr);
                        } else {
                            await lending.setFeeRecipient(owner.address);
                        }
                        const loanId = rng.nextInt(loanCount);
                        const loan = await lending.loans(loanId);
                        const l = lenders.find((u) => u.address !== loan.borrower) || user2;
                        await lending.connect(l).fundLoan(loanId, { value: loan.principalAmount });
                    } else if (action === 3 && loanCount > 0) {
                        // partial or full repayLoan
                        const loanId = rng.nextInt(loanCount);
                        const loan = await lending.loans(loanId);
                        const b = borrowers.find((u) => u.address === loan.borrower) || user1;
                        const isFull = rng.nextInt(2) === 0;
                        const payAmount = isFull
                            ? loan.remainingRepaymentAmount + ethers.parseEther("0.01")
                            : loan.remainingRepaymentAmount / 2n;
                        if (payAmount > 0n) {
                            await lending.connect(b).repayLoan(loanId, { value: payAmount });
                        }
                    } else if (action === 4 && loanCount > 0) {
                        // advance time and checkAndDeclareDefault
                        const loanId = rng.nextInt(loanCount);
                        const loan = await lending.loans(loanId);
                        if (Number(loan.state) === 1) {
                            await time.increase(11 * 86400);
                            await feed18.setLatestPrice(ethers.parseUnits("2", 8));
                            await feed6.setLatestPrice(ethers.parseUnits("2", 8));
                            await lending.connect(liquidator).checkAndDeclareDefault(loanId);
                        }
                    } else if (action === 5 && loanCount > 0) {
                        // drop price and liquidate
                        const loanId = rng.nextInt(loanCount);
                        const loan = await lending.loans(loanId);
                        if (Number(loan.state) === 1) {
                            await feed18.setLatestPrice(ethers.parseUnits("0.4", 8));
                            await feed6.setLatestPrice(ethers.parseUnits("0.4", 8));
                            await lending
                                .connect(liquidator)
                                .liquidate(loanId, { value: loan.remainingRepaymentAmount + ethers.parseEther("0.05") });
                        }
                    } else if (action === 6) {
                        // createLoanOffer
                        const l = rng.pick(lenders);
                        const principal = ethers.parseEther("0.5");
                        await lending
                            .connect(l)
                            .createLoanOffer(1500, 86400, 14 * 86400, ethers.ZeroAddress, 15000, {
                                value: principal,
                            });
                    } else if (action === 7 && offerCount > 0) {
                        // acceptLoanOffer
                        const offerId = rng.nextInt(offerCount);
                        const offer = await lending.loanOffers(offerId);
                        const b = borrowers.find((u) => u.address !== offer.lender) || user3;
                        await lending
                            .connect(b)
                            .acceptLoanOffer(offerId, 1000, 7 * 86400, t18Addr, ethers.parseUnits("2", 18));
                    } else if (action === 8 && offerCount > 0) {
                        // cancelLoanOffer
                        const offerId = rng.nextInt(offerCount);
                        const offer = await lending.loanOffers(offerId);
                        const l = lenders.find((u) => u.address === offer.lender) || user1;
                        await lending.connect(l).cancelLoanOffer(offerId);
                    } else if (action === 9 && offerCount > 0) {
                        // expireLoanOffer
                        const offerId = rng.nextInt(offerCount);
                        const offer = await lending.loanOffers(offerId);
                        if (Number(offer.state) === 0) {
                            await time.increase(31 * 86400);
                            await feed18.setLatestPrice(ethers.parseUnits("2", 8));
                            await feed6.setLatestPrice(ethers.parseUnits("2", 8));
                            await lending.connect(liquidator).expireLoanOffer(offerId);
                        }
                    } else if (action === 10) {
                        // withdrawETH from revertingFeeRecipient if queued
                        const pending = await lending.pendingETHWithdrawals(revertingAddr);
                        if (pending > 0n) {
                            await revertingFeeRecipient.setShouldRevert(false);
                            await revertingFeeRecipient.withdrawFromLending(lendingAddr);
                        }
                    } else if (action === 11) {
                        // donate unlocked tokens & ETH and rescue them
                        const extraTokens = ethers.parseUnits("5", 18);
                        await token18.mint(lendingAddr, extraTokens);
                        await lending.rescueTokens(t18Addr, extraTokens, owner.address);

                        const extraETH = ethers.parseEther("0.1");
                        await owner.sendTransaction({ to: lendingAddr, value: extraETH });
                        await lending.rescueETH(extraETH, owner.address);
                    }
                } catch {
                    // Expected domain reverts on randomized inputs must never corrupt protocol invariants
                }

                await assertProtocolInvariants(lending, tokens, trackedAddresses);
            }
        });
    }
});
