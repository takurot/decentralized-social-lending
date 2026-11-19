const { expect } = require("chai");
const hre = require("hardhat");
const {
    EIP170_LIMIT,
    EIP3860_INITCODE_LIMIT,
    WARN_THRESHOLD,
    checkContractSize,
} = require("../scripts/check-size");

describe("EIP-170 Contract Bytecode Size Gate (Issue #52)", function () {
    const TARGET_MAX_DEPLOYED_BYTES = WARN_THRESHOLD;

    it("should keep SocialLendingWithCollateral deployed bytecode well below EIP-170 and 90% warning ceiling (<= 22,118 B)", function () {
        const result = checkContractSize(TARGET_MAX_DEPLOYED_BYTES);

        expect(result.contractName).to.equal("SocialLendingWithCollateral");
        expect(result.deployedBytes).to.be.greaterThan(0);

        // solidity-coverage instruments every statement/branch into the artifact during coverage runs
        if (hre.__SOLIDITY_COVERAGE_RUNNING) {
            return;
        }

        expect(result.deployedBytes).to.be.at.most(EIP170_LIMIT);
        expect(result.deployedBytes).to.be.at.most(WARN_THRESHOLD);
        expect(result.deployedBytes).to.be.at.most(TARGET_MAX_DEPLOYED_BYTES);
        expect(result.headroom).to.be.at.least(EIP170_LIMIT - TARGET_MAX_DEPLOYED_BYTES);
        expect(result.initBytes).to.be.at.most(EIP3860_INITCODE_LIMIT);
    });
});
