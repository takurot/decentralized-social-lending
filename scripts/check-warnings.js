const fs = require("fs");
const path = require("path");

function listSolidityFiles(dir, result = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            listSolidityFiles(full, result);
        } else if (entry.name.endsWith(".sol")) {
            result.push(full);
        }
    }
    return result;
}

function isCoverageSyntheticWarning(diag, isCoverageInstrumented) {
    if (!isCoverageInstrumented) return false;
    const msg = diag.formattedMessage || diag.message || "";
    if (/function c_(true|false)[0-9a-f]{8}\(/.test(msg)) {
        return true;
    }
    if (String(diag.errorCode) === "5574") {
        // solidity-coverage instrumentation inflates bytecode above 24,576 B
        return true;
    }
    return false;
}

function checkBuildAndStaticAnalysis() {
    const rootDir = path.resolve(__dirname, "..");
    const buildInfoDir = path.join(rootDir, "artifacts", "build-info");
    if (!fs.existsSync(buildInfoDir)) {
        throw new Error(`Build-info directory not found at ${buildInfoDir}. Run "npx hardhat compile" first.`);
    }

    const buildInfoFiles = fs
        .readdirSync(buildInfoDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => path.join(buildInfoDir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

    if (buildInfoFiles.length === 0) {
        throw new Error("No build-info JSON files found. Run \"npx hardhat compile --force\" first.");
    }

    let selectedFile = buildInfoFiles[0];
    let selectedBuildInfo = JSON.parse(fs.readFileSync(selectedFile, "utf8"));
    let isCoverageInstrumented = false;

    for (const candidate of buildInfoFiles) {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
        const sources = (parsed.input && parsed.input.sources) || {};
        const instrumented = Object.values(sources).some(
            (s) => s && typeof s.content === "string" && /function c_true[0-9a-f]{8}\(/.test(s.content)
        );
        if (!instrumented) {
            selectedFile = candidate;
            selectedBuildInfo = parsed;
            isCoverageInstrumented = false;
            break;
        }
        isCoverageInstrumented = true;
    }

    const rawDiagnostics = (selectedBuildInfo.output && selectedBuildInfo.output.errors) || [];
    const errorsAndWarnings = rawDiagnostics.filter(
        (diag) => !isCoverageSyntheticWarning(diag, isCoverageInstrumented)
    );

    const staticFindings = [];
    const contractsDir = path.join(rootDir, "contracts");
    const solFiles = listSolidityFiles(contractsDir);

    for (const file of solFiles) {
        const rel = path.relative(rootDir, file);
        const src = fs.readFileSync(file, "utf8");
        if (!src.includes("pragma solidity 0.8.24;")) {
            staticFindings.push(`${rel}: missing pinned "pragma solidity 0.8.24;"`);
        }
        if (/\btx\.origin\b/.test(src)) {
            staticFindings.push(`${rel}: forbidden use of tx.origin`);
        }
        if (/\bselfdestruct\s*\(/.test(src)) {
            staticFindings.push(`${rel}: forbidden use of selfdestruct`);
        }
        if (/\bdelegatecall\s*\(/.test(src)) {
            staticFindings.push(`${rel}: forbidden use of delegatecall`);
        }
    }

    return {
        buildInfoFile: path.relative(rootDir, selectedFile),
        compilerDiagnostics: errorsAndWarnings,
        staticFindings,
        solFileCount: solFiles.length,
        ok: errorsAndWarnings.length === 0 && staticFindings.length === 0,
    };
}

if (require.main === module) {
    const report = checkBuildAndStaticAnalysis();
    console.log(
        `[Static & Build Check] Scanned ${report.solFileCount} Solidity files and ${report.buildInfoFile}: ${report.compilerDiagnostics.length} compiler warning(s)/error(s), ${report.staticFindings.length} static issue(s).`
    );

    if (report.compilerDiagnostics.length > 0) {
        for (const diag of report.compilerDiagnostics) {
            console.error(diag.formattedMessage || diag.message);
        }
    }
    if (report.staticFindings.length > 0) {
        for (const finding of report.staticFindings) {
            console.error(`Static analysis failure: ${finding}`);
        }
    }
    if (!report.ok) {
        process.exit(1);
    }
    console.log("Zero compiler warnings and all static analysis checks passed.");
}

module.exports = { checkBuildAndStaticAnalysis };
