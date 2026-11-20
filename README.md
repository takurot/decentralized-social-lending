# Decentralized Social Lending

A decentralized peer-to-peer ETH lending protocol on Ethereum backed by ERC-20 collateral and Chainlink price feeds.

## Features

- **Collateralized P2P ETH Lending**: Borrowers escrow whitelisted ERC-20 collateral and request ETH loans with custom principal, interest rate, and duration, or accept lender-initiated loan offers (`createLoanOffer` / `acceptLoanOffer`).
- **Grace Period, Default Settlement & Liquidation**: Overdue loans enter a configurable `gracePeriod` before maturity default (`declareDefault` / `checkAndDeclareDefault`), with an oracle-outage fallback after `ORACLE_FALLBACK_DELAY` (`7 days`) so broken or deprecated price feeds cannot permanently freeze collateral. Undercollateralized loans (`ratio < liquidationThreshold`) can be liquidated via `liquidate()`, returning surplus collateral above debt plus `liquidationBonus` to the borrower.
- **Chainlink Price Feed Validation**: Real-time collateral valuation with default (`PRICE_FEED_TIMEOUT = 1 hour`) and per-token configurable staleness timeouts (`setPriceFeedTimeout`, `5 minutes` to `48 hours`), round completeness, positive-price checks, `decimals <= 18` bounds, and full config-time round freshness probing (`setPriceFeed`). Asset-specific min/max price-range and deviation circuit-breaker monitoring is an off-chain operational responsibility (paired with governance feed replacement).
- **Social Credit Score**: On-chain borrower reputation tracking (`userReputations`, `getCreditScore`) recording completed and defaulted loans and repayment volume.
- **Security Controls**: `ReentrancyGuard`, `Pausable`, two-step ownership (`Ownable2Step` with `renounceOwnership()` permanently disabled), always-on 48-hour timelock governance (`timelockEnabled == true` from deployment, `TIMELOCK_GRACE_PERIOD = 14 days`, selector validation, duplicate-queue protection, `queueChange`, `cancelChange`), bounded-gas ETH transfer with pull-payment fallback (`pendingETHWithdrawals`, `withdrawETH`, `withdrawETHTo`), loan request expiration (`LOAN_REQUEST_EXPIRATION = 30 days`) with permissionless `expireLoanRequest(loanId)` cleanup and funding-time token allowlist and collateralization re-validation, platform fee snapshotting at request time, locked-collateral decimals mutation protection (`CollateralLocked`), per-borrower active loan caps, maximum loan amount limits, locked collateral/ETH protection on `rescueTokens` / `rescueETH`, and Checks-Effects-Interactions throughout.
- **Gas-Optimized Storage & Paginated Views**: Packed `Loan` struct slots, O(1) aggregate counters (`getStats()`), single-pass active borrower/lender loan views (`getBorrowerLoans`, `getLenderLoans`), and bounded paginated getters (`getBorrowerLoansPaginated`, `getLenderLoansPaginated`, `getLoanOffersPaginated`).

## Architecture & Extensibility Strategy

### Single-Contract Structure & Logical Module Boundaries

The protocol is implemented as a single self-contained contract, `SocialLendingWithCollateral` (`contracts/decentralizedSocialLending.sol`), organized into six logical domains that share core accounting state (`loans`, `loanOffers`, `lockedCollateral`, `lockedETH`, aggregate counters, and `userReputations`):

1. **Core Lending Lifecycle**: Borrower-initiated requests, cancellation, permissionless expiration, funding, and repayments (`requestLoan`, `cancelLoanRequest`, `expireLoanRequest`, `fundLoan`, `repayLoan`).
2. **Lender-Initiated Loan Offers**: Escrowed ETH offers and matching (`createLoanOffer`, `cancelLoanOffer`, `acceptLoanOffer`, `expireLoanOffer`).
3. **Default & Liquidation Engine**: Maturity default settlement with grace period (`declareDefault`, `checkAndDeclareDefault`, `_executeDefault`) and price-based collateral liquidation (`liquidate`).
4. **Oracle Valuation & Views**: Chainlink V3 price feed normalization (`getCollateralValueInETH`, `getCollateralizationRatio`), active user/protocol state queries (`getBorrowerLoans`, `getLenderLoans`, `getStats`), and paginated history/offer getters (`getBorrowerLoansPaginated`, `getLenderLoansPaginated`, `getLoanOffersPaginated`).
5. **Social Credit Score**: Reputation state and scoring formula (`userReputations`, `getCreditScore`).
6. **Governance, Timelock & Emergency Controls**: Two-step ownership (`transferOwnership` + `acceptOwnership`, disabled `renounceOwnership`), always-on 48-hour timelock queue with 14-day execution grace window (`queueChange`, `cancelChange`, `_consumeTimelock`), emergency pause (`pause`, `unpause`), pull-payment withdrawals (`withdrawETH`, `withdrawETHTo`), and unlocked asset recovery (`rescueTokens`, `rescueETH`).

### Explicit Scope Limits & Non-Goals

- **Intentionally Non-Upgradeable (Monolith without Proxy)**:
  The contract does **not** use an upgradeable proxy (`UUPS` or `TransparentUpgradeableProxy`). Avoiding proxy patterns eliminates storage-layout collision risks, initializer attack surfaces, and a standing admin upgrade key that could arbitrarily rewrite rules over active escrowed funds. Splitting the monolith into cross-contract modules is also deferred because core accounting state is updated across every lifecycle flow.
- **ETH-Only Lending Asset**:
  The lending and repayment asset is native **ETH** across all payable entry points (`fundLoan`, `repayLoan`, `liquidate`, `createLoanOffer`), pull-payment queues (`lockedETH`, `pendingETHWithdrawals`, `withdrawETH`), and collateral valuations (`getCollateralValueInETH`). Supporting ERC-20 lending assets (e.g., stablecoin principal) requires per-asset lending accounting and quote-currency normalization and is an explicit non-goal for `v1.x`.
- **Fixed Simple Interest Computed at Origination (No Early-Repayment Discount)**:
  Total repayment (`principalAmount + interestAmount`) is calculated once when a loan is created (`requestLoan` or `acceptLoanOffer`) using fixed simple interest over the agreed `duration`. Interest does not accrue continuously over time, and **repaying a loan early does not reduce the total interest owed**. Variable-rate or time-accrued interest models are out of scope for `v1.x`.

>If the project later targets mainnet expansion requiring modularization, proxy upgradeability, or ERC-20 lending support, each capability will be tracked and designed as a separate, dedicated issue and major release rather than retrofitted implicitly.

### Incident Response & Redeployment / Unwind Procedure

Because the contract is non-upgradeable, recovering from a critical vulnerability or migrating to a new contract version follows a controlled **Pause -> Redeploy -> User Unwind** procedure:

1. **Pause Active Operations**:
   The owner calls `pause()` on the affected contract, halting new loan requests (`requestLoan`), funding (`fundLoan`), offer creation/acceptance (`createLoanOffer`, `acceptLoanOffer`), defaults (`declareDefault`, `checkAndDeclareDefault`), and liquidations (`liquidate`).
2. **Deploy & Configure Replacement Contract**:
   Deploy a patched `SocialLendingWithCollateral` instance via `scripts/deploy.ts` (timelock is active by default from deployment), queue and execute whitelisted collateral tokens (`setCollateralTokenStatus`, `setCollateralTokenDecimals`) and Chainlink price feeds (`setPriceFeed`) through the 48-hour timelock, and transfer ownership to the governance multisig via two-step `transferOwnership` + `acceptOwnership`.
3. **User Position Unwind on the Paused Instance**:
   - **Unfunded Loan Requests**: Borrowers call `cancelLoanRequest(loanId)` (or anyone calls `expireLoanRequest(loanId)` after request expiry; both callable while paused) to reclaim 100% of their escrowed ERC-20 collateral.
   - **Open Loan Offers**: Lenders call `cancelLoanOffer(offerId)` (or anyone calls `expireLoanOffer(offerId)` after expiry; both callable while paused) to reclaim escrowed ETH.
   - **Queued Pull-Payment ETH**: Users with balances in `pendingETHWithdrawals` call `withdrawETH()` or `withdrawETHTo(recipient)` (callable while paused).
   - **Active `Funded` Loans**: Borrowers can call `repayLoan(loanId)` (callable while paused) to repay remaining debt and reclaim 100% of their escrowed collateral without waiting for `unpause()`.
   - **Unlocked Residual Assets**: The owner may recover only non-escrowed tokens or ETH via `rescueTokens` and `rescueETH` (which strictly protect `lockedCollateral` and `lockedETH`).
4. **Migrate Off-Chain Integrations**:
   Point frontends, scripts, and off-chain monitoring/indexers to the new contract address. Historical `loans` and `userReputations` remain readable on the retired contract for off-chain reference.

## Project Structure

- `contracts/decentralizedSocialLending.sol` — Main `SocialLendingWithCollateral` smart contract
- `contracts/interfaces/AggregatorV3Interface.sol` — Chainlink price feed interface
- `contracts/mocks/` — `MockERC20`, `MockFeeOnTransferERC20`, `MockPriceFeed`, and `MockRevertingReceiver` test doubles
- `scripts/deploy.ts` — Deployment script supporting `FEE_RECIPIENT` override
- `scripts/e2e-verify.ts` — 6-phase end-to-end lifecycle verification runner with 100% ABI function invocation audit
- `test/` — Hardhat test suites (including `test/E2E.test.js` and `test/Invariant.test.js`)

## Getting Started

```bash
npm install
npm run compile
npm test
npm run test:e2e
npm run e2e
npm run coverage
```

## Deployment (Sepolia / Local)

Configure the following environment variables before deploying to a live network:

- `SEPOLIA_RPC_URL` — Sepolia JSON-RPC endpoint URL
- `PRIVATE_KEY` — Deployer wallet private key
- `ETHERSCAN_API_KEY` — Etherscan API key for contract verification
- `FEE_RECIPIENT` — (Optional) Platform fee recipient address (defaults to deployer)
- `FORK_RPC_URL` — (Optional) JSON-RPC URL to enable Hardhat network forking for E2E / integration runs
- `FORK_BLOCK_NUMBER` — (Optional) Pinned block number when `FORK_RPC_URL` is set

```bash
npx hardhat run scripts/deploy.ts --network sepolia
```

## License

MIT
