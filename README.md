# Decentralized Social Lending

A Solidity smart contract for peer-to-peer loans backed by ERC20 collateral.

## Overview
The platform lets borrowers request ETH loans by locking supported tokens as collateral. Lenders can fund requests, earn interest, and recover funds or collateral depending on repayment. The contract is secured with OpenZeppelin libraries and Chainlink price feeds.

## Features
- Loan creation, funding, repayment, and default handling
- Collateral valuation via Chainlink oracles with timestamp checks
- Validation of collateral token addresses and decimals
- Secure ETH transfers using `Address.sendValue`
- Admin rescue functions for stuck tokens or ETH
- Protection with `ReentrancyGuard` and `Pausable`

## Repository Structure
- `contracts/`
  - `decentralizedSocialLending.sol` – main contract
  - `mocks/MockPriceFeed.sol` – configurable price feed for tests
- `test/SocialLendingWithCollateral.test.js` – Hardhat test suite
- `hardhat.config.ts` – Hardhat configuration

## Installation
```bash
npm install
```

## Running Tests
```bash
npx hardhat test
```

## Deployment
Deploy the contract with your preferred Hardhat network configuration and set the Chainlink price feed addresses and initial collateral settings as needed.

## Security Notes
This project is for educational use and has not undergone a formal security audit. Use caution before deploying to production.

## License
MIT
