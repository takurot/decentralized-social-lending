const { expect } = require("chai");
const { ethers } = require("hardhat");
const deployModule = require("../scripts/deploy");
const { deployContract, main } = deployModule;
const { checkBuildAndStaticAnalysis } = require("../scripts/check-warnings");

describe("Deploy Script & Build Checks (Issues #17, #57)", function () {
    let savedFeeRecipient;

    beforeEach(function () {
        savedFeeRecipient = process.env.FEE_RECIPIENT;
        delete process.env.FEE_RECIPIENT;
    });

    afterEach(function () {
        if (savedFeeRecipient !== undefined) {
            process.env.FEE_RECIPIENT = savedFeeRecipient;
        } else {
            delete process.env.FEE_RECIPIENT;
        }
    });

    it("should deploy SocialLendingWithCollateral with deployer as default feeRecipient", async function () {
        const [deployer] = await ethers.getSigners();
        const contract = await deployContract();
        const address = await contract.getAddress();

        expect(ethers.isAddress(address)).to.equal(true);
        expect(await contract.owner()).to.equal(deployer.address);
        expect(await contract.feeRecipient()).to.equal(deployer.address);
    });

    it("should deploy SocialLendingWithCollateral with a custom feeRecipient", async function () {
        const [, customRecipient] = await ethers.getSigners();
        const contract = await deployContract(customRecipient.address);

        expect(await contract.feeRecipient()).to.equal(customRecipient.address);
    });

    it("should use FEE_RECIPIENT environment variable when no argument is provided", async function () {
        const [, , envRecipient] = await ethers.getSigners();
        process.env.FEE_RECIPIENT = envRecipient.address;

        const contract = await deployContract();
        expect(await contract.feeRecipient()).to.equal(envRecipient.address);
    });

    it("should execute main() and log network, chainId, deployed address, and feeRecipient", async function () {
        await main();
    });

    it("should reject invalid, empty, or zero-address feeRecipient before deployment", async function () {
        await expect(deployContract("")).to.be.rejectedWith(/Invalid feeRecipient address/i);
        await expect(deployContract("not-an-address")).to.be.rejectedWith(/Invalid feeRecipient address/i);
        await expect(deployContract(ethers.ZeroAddress)).to.be.rejectedWith(/Invalid feeRecipient address/i);

        process.env.FEE_RECIPIENT = ethers.ZeroAddress;
        await expect(deployContract()).to.be.rejectedWith(/Invalid feeRecipient address/i);
    });

    it("should throw a descriptive error when no deployer signer is configured", async function () {
        const origGetSigners = ethers.getSigners;
        ethers.getSigners = async () => [];
        try {
            await expect(deployContract()).to.be.rejectedWith(/No deployer signer available/i);
            await expect(main()).to.be.rejectedWith(/No deployer signer available/i);
        } finally {
            ethers.getSigners = origGetSigners;
        }
    });

    it("should have zero Solidity compiler warnings and pass static analysis", function () {
        const report = checkBuildAndStaticAnalysis();
        expect(report.compilerDiagnostics).to.deep.equal([]);
        expect(report.staticFindings).to.deep.equal([]);
        expect(report.ok).to.equal(true);
    });
});
