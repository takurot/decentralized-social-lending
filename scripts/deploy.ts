import { ethers } from "hardhat";

export async function deployContract(feeRecipient?: string) {
    const signers = await ethers.getSigners();
    const deployer = signers[0];
    if (!deployer) {
        throw new Error("No deployer signer available. Check PRIVATE_KEY configuration.");
    }

    const resolvedFeeRecipient =
        feeRecipient !== undefined
            ? feeRecipient
            : process.env.FEE_RECIPIENT !== undefined && process.env.FEE_RECIPIENT !== ""
              ? process.env.FEE_RECIPIENT
              : deployer.address;

    if (!ethers.isAddress(resolvedFeeRecipient) || resolvedFeeRecipient === ethers.ZeroAddress) {
        throw new Error(`Invalid feeRecipient address: "${resolvedFeeRecipient}"`);
    }

    const LendingFactory = await ethers.getContractFactory("SocialLendingWithCollateral");
    const lending = await LendingFactory.deploy(resolvedFeeRecipient);
    await lending.waitForDeployment();

    return lending;
}

export async function main() {
    const signers = await ethers.getSigners();
    const deployer = signers[0];
    if (!deployer) {
        throw new Error("No deployer signer available. Check PRIVATE_KEY configuration.");
    }

    const network = await ethers.provider.getNetwork();
    console.log(
        `Deploying SocialLendingWithCollateral on network "${network.name}" (chainId: ${network.chainId.toString()}) with account:`,
        deployer.address
    );

    const lending = await deployContract();
    const address = await lending.getAddress();
    const feeRecipient = await lending.feeRecipient();

    console.log("SocialLendingWithCollateral deployed to:", address);
    console.log("Fee recipient:", feeRecipient);
    console.log("Timelock enabled by default:", await lending.timelockEnabled());
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
