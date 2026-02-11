# Repository Guidelines

## Project Structure & Module Organization
- `contracts/` contains Solidity sources.
- `contracts/decentralizedSocialLending.sol` is the main lending contract.
- `contracts/interfaces/` and `contracts/mocks/` hold oracle interfaces and test doubles.
- `test/` contains Hardhat test suites (`BasicTest.js`, `SocialLendingWithCollateral.test.js`).
- `artifacts/`, `cache/`, `coverage/`, and `typechain-types/` are generated outputs; do not hand-edit them.
- `hardhat.config.ts` defines compiler, paths, gas reporting, and network defaults.

## Build, Test, and Development Commands
- `npm install` installs dependencies.
- `npx hardhat compile` compiles contracts with Solidity `0.8.24` settings.
- `npm test` runs the full Hardhat test suite.
- `npx hardhat test test/BasicTest.js` runs a single test file.
- `npx hardhat coverage` generates Solidity coverage reports (`coverage/`, `coverage.json`).
- `REPORT_GAS=1 npx hardhat test` enables gas reporting during tests.

## Coding Style & Naming Conventions
- Use 4-space indentation in Solidity and JavaScript tests.
- Follow Solidity conventions: `PascalCase` for contract names, `camelCase` for functions/variables, `UPPER_SNAKE_CASE` for constants.
- Prefer custom errors and explicit events for state transitions.
- Add concise NatSpec comments for public/external functions.
- Keep new files aligned with existing naming patterns (for example, `FeatureName.test.js` in `test/`).

## Testing Guidelines
- Framework: Hardhat + Mocha + Chai (`@nomicfoundation/hardhat-toolbox`).
- Cover both success and failure paths, especially access control, collateral validation, oracle input checks, and repayment/default transitions.
- For revert checks, use `revertedWithCustomError` when applicable.
- Contract changes should include test updates in the same pull request.

## Security & Configuration Tips
- Keep privileged paths (`onlyOwner` setters, pause/unpause, rescue functions) explicitly tested when modified.
- Use mock feeds/tokens in tests (`contracts/mocks/`) instead of live addresses.
- Store sensitive network values (RPC URLs, private keys) in environment variables; never commit secrets.
- Enable `REPORT_GAS=1` for changes that may affect borrower/lender transaction costs.

## Commit & Pull Request Guidelines
- Recent history uses concise imperative subjects, often with prefixes like `feat:`, `fix:`, `docs:`, and `build:`; keep that format.
- Keep commits focused (one logical change per commit).
- PRs should include a short behavior summary, linked issue(s) when available, executed test commands/results, and security impact notes for contract logic changes.
