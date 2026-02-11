# Implementation Playbook (AI Agent)

Use this file as the default execution rules for implementing tasks/PRs in this repository.

## Inputs (What you are given)
- A PR identifier (e.g., **PR-03**, **PR-08**) or a request to implement a subset of tasks.
- A reference to `prompt/PLAN.md` for the specific scope.

## Primary References & Priority
**Rule of Thumb**: When in doubt, follow the document higher in this list.

1. **System/Developer Instructions**: Direct commands from the user or agent runtime (Top Priority)
2. **Specification**: `prompt/SPEC.md` (Source of Truth for Requirements)
3. **Implementation Plan**: `prompt/PLAN.md` (Source of Truth for Steps & Dependencies)
4. **Existing Code**: Current implementation (unless SPEC/PLAN explicitly says to change it)
5. **This Playbook**: `prompt/PROMPT.md` (Process & Default Rules)
6. **Guidelines**: `AGENTS.md` (Coding Style)

---

## Default Project Principles (Override via PLAN.md)

### 1) Security First (Funds > Features)
- **Checks-Effects-Interactions**: always update state variables before external calls.
- **Reentrancy Protection**: Use `nonReentrant` on all external/public functions that modify state.
- **SafeERC20**: Always use `SafeERC20` wrapper for token transfers.
- **Access Control**: Strict `onlyOwner` or role-based checks for administrative functions.

### 2) Gas Optimization (Target)
- **Structure**: Pack structs tightly where possible (e.g. `uint128` + `uint128`).
- **Loops**: Prefer O(1) mappings/counters over unbound loops.
  - *Exception*: If `PLAN.md` schedules optimization for a later PR (e.g. PR-04), follow the plan.

### 3) Testing & Verification
- **TDD (Test-Driven Development)**: Write failing tests (`test/*.test.js`) before implementing logic.
- **Coverage Goal**: PR Finalization requires meeting project standards (95% Statements / 100% Functions).
  - *Note*: Intermediate commits should focus on passing new tests and preventing regressions.
- **Edge Cases**: Explicitly test boundaries (0, MAX_UINT, `MAX_LOAN_DURATION`, etc.).

### 4) Code Quality
- **English Only**: All comments and identifiers MUST be in English.
- **NatSpec**: Full NatSpec coverage for all public/external functions, events, and errors.
- **Custom Errors**: Use `error ErrorName(args)` instead of `require(cond, "string")`.

---

## Standard Implementation Workflow

### 1) Pre-flight
- Read the relevant section in `prompt/PLAN.md`.
- Confirm dependencies (e.g., "Review PR-XX before implementing PR-YY").
- Create a short checklist of file changes.

### 2) Branching
- Branch name conventions:
  - Feature: `feat/pr-<id>-<description>` (e.g. `feat/pr-06-liquidation`)
  - Fix: `fix/pr-<id>-<description>` (e.g. `fix/pr-01-cleanup`)
  - Chore: `chore/pr-<id>-<description>`

### 3) Environment Setup
```bash
npm ci
npx hardhat compile
```

### 4) TDD Cycle (Iterative)
1.  **Red**: Create/Update `test/FeatureName.test.js`. Add a test case that fails.
2.  **Green**: Implement the minimum Solidity code to pass.
3.  **Refactor**: Optimize gas, add comments.
4.  **Verify**: `npx hardhat test`

> **Note**: For non-code changes (e.g. docs, CI), new tests are not required. Run full regression tests only.

**Failure Recovery**:
- If compile fails: `npx hardhat clean && npx hardhat compile`
- If test fails: `npx hardhat test --grep "Test Name"` to isolate.
- If generic error: Use `console.log` or `npx hardhat test --show-stack-traces`.

### 5) PR Finalization (Mandatory)
- **Run Full Tests**:
  ```bash
  npx hardhat test
  ```
- **Check Gas**:
  ```bash
  REPORT_GAS=true npx hardhat test
  ```
- **Check Coverage**:
  ```bash
  npx hardhat coverage
  ```
  *Ensure it meets the thresholds defined in `PLAN.md`.*

- **Linting** (If configured in `package.json`):
  ```bash
  npm run lint
  ```

### 6) Submission
- Update `prompt/PLAN.md` checkboxes if instructed.
- Ensure no console logs or temporary comments remain.

---

## Key Data Structures (Reference)
*Always refer to `prompt/SPEC.md` or existing code for the exact definition.*

### Loan
- Defined in `contracts/decentralizedSocialLending.sol`
- Key fields: `principalAmount`, `repaymentAmount`, `interestRate`, `duration`, `startTime`, `state`

### LoanState
- Refer to `prompt/SPEC.md` for the definition relevant to the current PR (e.g. `Liquidated` is added in PR-06).

### UserReputation / LoanOffer
- See `prompt/SPEC.md` for full definition.

---

## Checklist (Before Completing Task)
- [ ] **Tests**: All tests pass (`npx hardhat test`).
- [ ] **Coverage**: Standards met (as per `PLAN.md`).
- [ ] **Security**: No reentrancy risks or unchecked external calls.
- [ ] **Gas**: Verify gas usage is reasonable.
- [ ] **Docs**: NatSpec is complete and English-only.
