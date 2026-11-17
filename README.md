# Decentralized Social Lending

A decentralized peer-to-peer ETH lending protocol on Ethereum backed by ERC-20 collateral and Chainlink price feeds.

## Features

- **Collateralized P2P ETH Lending**: Borrowers escrow whitelisted ERC-20 collateral and request ETH loans with custom principal, interest rate, and duration.
- **Chainlink Price Feed Validation**: Real-time collateral valuation with staleness (`PRICE_FEED_TIMEOUT = 1 hour`), round completeness, positive-price checks, `decimals <= 18` bounds, and config-time feed probing (`setPriceFeed`). Asset-specific min/max price-range and deviation circuit-breaker monitoring is an off-chain operational responsibility (paired with governance feed replacement).
- **Security Controls**: `ReentrancyGuard`, `Pausable`, `Ownable`, per-borrower active loan caps, maximum loan amount limits, locked collateral protection on `rescueTokens`, and Checks-Effects-Interactions throughout.
- **Gas-Optimized Storage**: Packed `Loan` struct slots, O(1) aggregate counters (`getStats()`), and indexed borrower/lender loan lookups.

## Project Structure

- `contracts/decentralizedSocialLending.sol` — Main `SocialLendingWithCollateral` smart contract
- `contracts/interfaces/AggregatorV3Interface.sol` — Chainlink price feed interface
- `contracts/mocks/` — `MockERC20` and `MockPriceFeed` test doubles
- `scripts/deploy.ts` — Deployment script supporting `FEE_RECIPIENT` override
- `test/` — Hardhat test suites

## Getting Started

```bash
npm install
npm run compile
npm test
npm run coverage
```

## Deployment (Sepolia / Local)

Configure the following environment variables before deploying to a live network:

- `SEPOLIA_RPC_URL` — Sepolia JSON-RPC endpoint URL
- `PRIVATE_KEY` — Deployer wallet private key
- `ETHERSCAN_API_KEY` — Etherscan API key for contract verification
- `FEE_RECIPIENT` — (Optional) Platform fee recipient address (defaults to deployer)

```bash
npx hardhat run scripts/deploy.ts --network sepolia
```

## License

MIT
