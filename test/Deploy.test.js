const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployContract } = require("../scripts/deploy");

describe("Deploy Script (Issue #17)", function () {
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
});
