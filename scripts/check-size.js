const fs = require("fs");
const path = require("path");

const EIP170_LIMIT = 24576;
const EIP3860_INITCODE_LIMIT = 49152;
const WARN_THRESHOLD = Math.floor(EIP170_LIMIT * 0.9); // 22,118 bytes (90%)

function getByteLength(hexString) {
    if (!hexString || hexString === "0x") return 0;
    return (hexString.startsWith("0x") ? hexString.length - 2 : hexString.length) / 2;
}

function checkContractSize(maxDeployedBytes = WARN_THRESHOLD) {
    const artifactPath = path.resolve(
        __dirname,
        "../artifacts/contracts/decentralizedSocialLending.sol/SocialLendingWithCollateral.json"
    );
    if (!fs.existsSync(artifactPath)) {
        throw new Error(`Artifact not found at ${artifactPath}. Run "npx hardhat compile" first.`);
    }

    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const deployedBytes = getByteLength(artifact.deployedBytecode);
    const initBytes = getByteLength(artifact.bytecode);
    const deployedPct = ((deployedBytes / EIP170_LIMIT) * 100).toFixed(2);
    const initPct = ((initBytes / EIP3860_INITCODE_LIMIT) * 100).toFixed(2);
    const headroom = EIP170_LIMIT - deployedBytes;

    return {
        contractName: artifact.contractName,
        deployedBytes,
        initBytes,
        deployedPct,
        initPct,
        headroom,
        eip170Limit: EIP170_LIMIT,
        eip3860Limit: EIP3860_INITCODE_LIMIT,
        maxDeployedBytes,
        withinEip170: deployedBytes <= EIP170_LIMIT,
        withinInitLimit: initBytes <= EIP3860_INITCODE_LIMIT,
        withinTarget: deployedBytes <= maxDeployedBytes,
    };
}

if (require.main === module) {
    const maxBytes = process.env.MAX_CONTRACT_BYTES
        ? Number(process.env.MAX_CONTRACT_BYTES)
        : WARN_THRESHOLD;
    const result = checkContractSize(maxBytes);
    console.log(
        `[Contract Size] ${result.contractName}: deployed=${result.deployedBytes} B / ${result.eip170Limit} B (${result.deployedPct}%, headroom=${result.headroom} B), initcode=${result.initBytes} B / ${result.eip3860Limit} B (${result.initPct}%)`
    );

    if (!result.withinEip170) {
        console.error(
            `ERROR: ${result.contractName} deployed bytecode (${result.deployedBytes} B) exceeds EIP-170 limit (${result.eip170Limit} B)`
        );
        process.exit(1);
    }
    if (!result.withinInitLimit) {
        console.error(
            `ERROR: ${result.contractName} initcode (${result.initBytes} B) exceeds EIP-3860 limit (${result.eip3860Limit} B)`
        );
        process.exit(1);
    }
    if (!result.withinTarget) {
        console.error(
            `ERROR: ${result.contractName} deployed bytecode (${result.deployedBytes} B) exceeds target ceiling (${result.maxDeployedBytes} B)`
        );
        process.exit(1);
    }
    console.log(`Contract size check passed (<= ${result.maxDeployedBytes} B target).`);
}

module.exports = {
    EIP170_LIMIT,
    EIP3860_INITCODE_LIMIT,
    WARN_THRESHOLD,
    checkContractSize,
};
