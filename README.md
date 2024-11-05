# Social Lending with Collateral Smart Contract

This repository provides a Solidity smart contract implementation for a collateral-backed social lending platform. This contract facilitates secure and efficient peer-to-peer lending between borrowers and lenders on the Ethereum network.

## Overview

This smart contract provides the following key features:

- **Loan Request Creation**: Borrowers can request loans by specifying terms (loan amount, interest rate, duration, collateral).
- **Loan Funding**: Lenders can review and fund loan requests, agreeing to the proposed terms.
- **Repayment Management**: Borrowers can repay loans in full or in part, providing flexible repayment options.
- **Default Processing**: If a loan reaches its expiration without full repayment, the lender or third party can declare a default and liquidate the collateral.
- **Collateral Valuation**: Uses Chainlink Oracles to assess the value of collateral tokens to ensure an appropriate loan-to-value (LTV) ratio.
- **Platform Fee**: Collects platform fees upon loan funding for platform maintenance and operations.

```markdown
+----------------------------------------------------+
|            Decentralized Social Lending            |
|        Connecting Borrowers and Lenders            |
+----------------------------------------------------+
                          |
                          |
              +-----------+-----------+
              |                       |
    +---------v---------+   +---------v---------+
    |       Borrower    |   |        Lender     |
    +--------------------+   +--------------------+
              |                       |
              |                       |
              |                       |
              |                       |
              v                       v
    +------------------------------------------------+
    |           Smart Contract with Collateral       |
    |                                                |
    |  - Loan Request Creation                       |
    |  - Collateral Locking                          |
    |  - Loan Funding                                |
    |  - Repayment Management                        |
    |  - Default Handling and Collateral Liquidation |
    +------------------------------------------------+
                          |
                          |
                          v
            +-------------------------------+
            |  Secure Loan Transactions     |
            |   on the Ethereum Blockchain  |
            +-------------------------------+
```

### Basic Concept:

1. **Borrower and Lender**: Borrowers and lenders connect on a decentralized social lending platform, creating a peer-to-peer network for lending.
2. **Smart Contract with Collateral**: The smart contract manages the loan process and ensures security through the following functions:
   - **Loan Request Creation**: Borrowers can create loan requests, specifying terms like loan amount and duration.
   - **Collateral Locking**: Collateral is locked within the contract as a security measure.
   - **Loan Funding**: Lenders review and fund loan requests, transferring funds to the borrower.
   - **Repayment Management**: Borrowers repay the loan, and the smart contract tracks repayments.
   - **Default Handling and Collateral Liquidation**: If a borrower defaults, the collateral is automatically liquidated to repay the lender.
3. **Secure Loan Transactions on Ethereum**: All transactions are securely recorded on the Ethereum blockchain, enabling trustless, transparent, and secure lending without intermediaries.

## Features

- **Secure Token Transfers**: Uses OpenZeppelin’s `SafeERC20` library for secure token transfers.
- **Reentrancy Protection**: Implements `ReentrancyGuard` to prevent reentrancy attacks.
- **Loan State Management**: Manages loan states with an enum, clearly indicating the loan’s current status.
- **Partial Repayment Support**: Allows borrowers to make partial repayments to enable flexible repayment schedules.
- **Automated Default Detection**: Allows anyone to check and declare a default if a loan has expired.
- **Event Emission**: Emits events for critical actions, making off-chain monitoring easier.

## Requirements

- Solidity ^0.8.0
- OpenZeppelin Contracts
- Chainlink Oracles

## Installation

1. **Clone the repository**

   ```bash
   git clone https://github.com/yourusername/social-lending-with-collateral.git
   cd social-lending-with-collateral
   ```

2. **Install dependencies**

   Run the following command in the root directory to install the necessary dependencies:

   ```bash
   npm install @openzeppelin/contracts
   npm install @chainlink/contracts
   ```

## Usage

### Deploy the Contract

1. **Compile the Contract**

   Use a Solidity compiler (such as `solc`, `truffle`, or `hardhat`) to compile the contract.

2. **Deploy**

   Deploy the contract to the Ethereum network using your preferred tool (e.g., Remix, Truffle, Hardhat).

### Key Functions

#### 1. Request a Loan

   ```solidity
   function requestLoan(
       uint256 amount,
       uint256 interestRate,
       uint256 duration,
       address collateralToken,
       uint256 collateralAmount
   ) external
   ```

   - **Description**: Allows a borrower to request a loan.
   - **Parameters**:
     - `amount`: Desired loan amount (in ETH)
     - `interestRate`: Interest rate (basis points, e.g., 500 for 5%)
     - `duration`: Loan duration (in seconds)
     - `collateralToken`: Address of the ERC20 token used as collateral
     - `collateralAmount`: Amount of collateral tokens

#### 2. Cancel Loan Request

   ```solidity
   function cancelLoanRequest(uint256 loanId) external
   ```

   - **Description**: Allows a borrower to cancel the loan request before funding.
   - **Parameters**:
     - `loanId`: ID of the loan

#### 3. Fund a Loan

   ```solidity
   function fundLoan(uint256 loanId) external payable
   ```

   - **Description**: Allows a lender to fund a loan request.
   - **Parameters**:
     - `loanId`: ID of the loan

#### 4. Repay Loan

   ```solidity
   function repayLoan(uint256 loanId) external payable
   ```

   - **Description**: Allows a borrower to repay the loan, supporting partial repayments.
   - **Parameters**:
     - `loanId`: ID of the loan

#### 5. Declare Default

   ```solidity
   function declareDefault(uint256 loanId) external
   ```

   - **Description**: Allows a lender to declare a default and seize collateral if the loan is overdue.
   - **Parameters**:
     - `loanId`: ID of the loan

#### 6. Automatic Default Detection and Declaration

   ```solidity
   function checkAndDeclareDefault(uint256 loanId) external
   ```

   - **Description**: Allows anyone to check for overdue loans and declare a default if applicable.
   - **Parameters**:
     - `loanId`: ID of the loan

#### 7. Get Collateral Value in ETH

   ```solidity
   function getCollateralValueInETH(address collateralToken, uint256 collateralAmount) public view returns (uint256)
   ```

   - **Description**: Retrieves the current value of collateral tokens in ETH.
   - **Parameters**:
     - `collateralToken`: Address of the collateral token
     - `collateralAmount`: Amount of collateral tokens

### Admin Functions

> **Note**: These functions require access control to restrict them to the contract administrator.

#### 1. Set Price Feed for Collateral Tokens

   ```solidity
   function setPriceFeed(address token, address priceFeed) external
   ```

   - **Description**: Sets the Chainlink price feed for a specific collateral token.

#### 2. Set Platform Fee

   ```solidity
   function setPlatformFee(uint256 _platformFee) external
   ```

   - **Description**: Sets the platform fee (basis points).

#### 3. Set Fee Recipient

   ```solidity
   function setFeeRecipient(address _feeRecipient) external
   ```

   - **Description**: Sets the recipient address for platform fees.

#### 4. Set LTV Ratio

   ```solidity
   function setLTVRatio(uint256 _ltvRatio) external
   ```

   - **Description**: Sets the loan-to-value (LTV) ratio.

## Events

- `LoanRequested`: Emitted when a loan is requested.
- `LoanFunded`: Emitted when a loan is funded.
- `LoanPartiallyRepaid`: Emitted when a loan is partially repaid.
- `LoanRepaid`: Emitted when a loan is fully repaid.
- `DefaultDeclared`: Emitted when a default is declared.
- `LoanCancelled`: Emitted when a loan request is canceled.

## Block Diagram

以下がマークダウン形式で表現したブロック図です。この図は、GitHubや他のマークダウン対応プラットフォームでそのまま閲覧できるようにしています。

```markdown
+-------------------------------+
|       Social Lending          |
|     with Collateral           |
+-------------------------------+
               |
               |
+--------------v---------------+
|     Borrower Requests        |
|        Loan Details          |
| (amount, interest rate,      |
|  duration, collateral)       |
+--------------+---------------+
               |
               |
+--------------v---------------+
|   Loan Request Created       |
|  Collateral Locked in        |
|      Contract                |
+--------------+---------------+
               |
               |
+--------------v---------------+
|     Lender Reviews           |
|       & Funds Loan           |
|       (ETH transferred)      |
+--------------+---------------+
               |
               |
+--------------v---------------+
|    Loan Funded: Contract     |
|    Transfers ETH to          |
|        Borrower              |
+--------------+---------------+
               |
               |
+--------------v---------------+
|   Borrower Repays Loan       |
|     (Full or Partial)        |
+--------------+---------------+
               |
               |
+--------------v---------------+
|    Loan Repayment Status     |
|       Checked & Updated      |
+--------------+---------------+
               |
               |
   +-----------+-----------+
   |                       |
   |                       |
+--v--+               +----v----+
|Loan |               | Default |
|Repaid                Declared |
| (Full repayment)     (Expired |
| triggers release     loan,    |
| of collateral)       collateral|
|                       liquidated|
+------+               +---------+
```

### Explanation:

1. **Borrower Requests Loan**: The borrower submits loan details such as the amount, interest rate, duration, and collateral.
2. **Loan Request Created**: The collateral is locked in the contract, and the loan request is created.
3. **Lender Funds Loan**: The lender reviews and funds the loan by transferring ETH.
4. **Loan Funded**: The smart contract transfers ETH to the borrower, completing the loan.
5. **Borrower Repays Loan**: The borrower repays the loan in full or partially.
6. **Loan Repayment Status Checked & Updated**: The contract checks and updates the loan repayment status.
7. **Loan Repaid**: If the loan is fully repaid, the collateral is released back to the borrower.
8. **Default Declared**: If the loan is overdue, a default is declared, and the collateral is liquidated to the lender.

## Security Notes

- **Audit**: This contract is intended for educational purposes and should undergo a security audit before deployment in a production environment.
- **Access Control**: Admin functions should be restricted to authorized addresses, such as the contract owner.
- **Oracle Reliability**: Ensure that the Chainlink oracles are configured correctly and trustworthy.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more details.

## Contributing

Bug reports and feature requests are welcome. Please reach out via Issues or submit a Pull Request.

proper testing and validation for a safe and secure implementation on the Ethereum network.
