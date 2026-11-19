const { expect } = require("chai");
const { runE2EVerification } = require("../scripts/e2e-verify");

describe("Comprehensive End-to-End Lifecycle Verification (Issue #64)", function () {
    it("should execute all 6 protocol lifecycle phases end-to-end, invoke 100% of contract ABI functions, and preserve zero-residual accounting invariants", async function () {
        const report = await runE2EVerification({ silent: true });

        expect(report.phasesCompleted).to.equal(6);
        expect(report.totalAbiFunctions).to.be.greaterThan(60);
        expect(report.missingFunctions).to.deep.equal([]);
        expect(report.calledFunctionCount).to.equal(report.totalAbiFunctions);

        // Final accounting invariants
        expect(report.finalState.lockedETH).to.equal(0n);
        expect(report.finalState.contractETHBalance).to.equal(0n);
        expect(report.finalState.activeLoansCount).to.equal(0n);
        expect(report.finalState.allTokenLockedCollateralZero).to.equal(true);
        expect(report.finalState.allTokenBalancesZero).to.equal(true);
        expect(report.finalState.statsConsistent).to.equal(true);
        expect(report.finalState.timelockEnabled).to.equal(true);
        expect(report.finalState.ownerAfterRenounce).to.equal("0x0000000000000000000000000000000000000000");
    });
});
