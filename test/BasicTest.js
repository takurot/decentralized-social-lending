const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Basic Contract Test", function () {
  it("should deploy the contract successfully", async function () {
    const [owner, feeRecipient] = await ethers.getSigners();
    
    const SocialLendingWithCollateral = await ethers.getContractFactory("SocialLendingWithCollateral");
    const lendingContract = await SocialLendingWithCollateral.deploy(feeRecipient.address);
    
    expect(await lendingContract.owner()).to.equal(owner.address);
    expect(await lendingContract.feeRecipient()).to.equal(feeRecipient.address);
    expect(await lendingContract.platformFee()).to.equal(100); // 1%
    expect(await lendingContract.ltvRatio()).to.equal(5000); // 50%
  });
});
