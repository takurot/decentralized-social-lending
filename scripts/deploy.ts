import { ethers } from "hardhat";

export async function deployContract(feeRecipient?: string) {
    const [deployer] = await ethers.getSigners();
    const resolvedFeeRecipient = feeRecipient || process.env.FEE_RECIPIENT || deployer.address;

    const LendingFactory = await ethers.getContractFactory("SocialLendingWithCollateral");
    const lending = await LendingFactory.deploy(resolvedFeeRecipient);
    await lending.waitForDeployment();

    return lending;
}

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying SocialLendingWithCollateral with account:", deployer.address);

    const lending = await deployContract();
    const address = await lending.getAddress();
    const feeRecipient = await lending.feeRecipient();

    console.log("SocialLendingWithCollateral deployed to:", address);
    console.log("Fee recipient:", feeRecipient);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
