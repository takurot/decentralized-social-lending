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
- PRs should include a short behavior summary, linked issue(s) when available, executed test commands/results, compatibility/security impact notes for contract logic changes, and any unverified items.

## Development Workflow (6-Stage Implementation Process)
Agents and contributors follow this 6-stage workflow for implementation tasks. Standard implementation requests proceed through PR creation and the review/improvement loop unless the user explicitly limits the scope.

### Common Workspace Rules
- Check `git status` before starting to preserve any existing uncommitted work. Use one branch (and one worktree when parallelizing) per task.
- Base new work on the latest `main` of the target repository/fork; verify the remote URL rather than assuming by remote name alone.
- In scheduler-managed or pre-provisioned worktrees, work on the assigned branch without switching branches or syncing `main`.
- Use the existing pinned toolchain and lockfile (`package-lock.json`); do not mix unrelated dependency updates into feature or fix PRs.

### 1. Specification & Planning
- Read the issue/request, `README.md`, relevant specifications (`prompt/SPEC.md`, `prompt/PLAN.md`), existing implementations, and tests to identify requirements and contradictions. Never resolve contradictions by guessing.
- Summarize scope, non-goals, dependencies, design decisions, acceptance criteria, and test strategy in a specification or implementation plan before coding.
- For complex plans or architectural decisions, leverage planning/architecture subagents and break implementation into small, verifiable steps.

### 2. Subagent Specification Review
- Have an independent subagent (different from the specification author) review the plan for missing requirements, design soundness, security risks, and testability.
- Incorporate valid feedback into the specification and re-review; document explicit rationale for any rejected feedback.
- Proceed to TDD implementation only after all valid findings are resolved.

### 3. TDD Implementation (Red → Green → Refactor)
- Write tests expressing the acceptance criteria first and verify they fail for the expected reason (**Red**).
- Write the minimal implementation needed to pass the tests (**Green**), then clean up responsibilities, duplication, and naming while keeping tests passing (**Refactor**).
- Verify both success paths and critical failure/revert paths at the appropriate test layers, isolating external dependencies with mocks/fixtures (e.g., `contracts/mocks/`).
- Validate inputs at boundaries and build state updates cleanly; never leave secrets in code, logs, or fixtures.
- Distinguish live/external state from stored/mocked state, validate before state-changing operations, and verify post-state (checks-effects-interactions and readback verification).
- Never treat partial success, uncertain post-write state, or unverifiable outcomes as success; preserve diagnostic context for recovery.
- Update relevant documentation alongside behavioral changes. For docs-only changes, verify content, links, and diffs without adding unnecessary runtime tests.

### 4. Verification & Quality Gates
- Run targeted tests first, then execute the repository's full quality gates and CI checks before opening a PR:
  - `npx hardhat compile`
  - `npm test` (or `npx hardhat test`)
  - `npx hardhat coverage` (verify against project/CI coverage thresholds and record measured results; never report unmeasured coverage as passing)
  - `REPORT_GAS=1 npx hardhat test` when changes may affect gas costs
- If dependencies change, inspect lockfile diffs and check for vulnerabilities.
- Fix failures and re-verify. If any check cannot run due to environment constraints, record the reason and unverified scope explicitly—never report skipped or environment-blocked checks as `PASS`.

### 5. Commit, Push, and PR Creation
- Run `git diff --check` and review the full diff to ensure no secrets or unrelated changes are included.
- Stage only the intended files and commit using the `<type>: <description>` convention.
- Verify the target remote, working branch, and outgoing diff before pushing. Never force-push or push directly to `main`.
- Create a PR only after required verifications pass (mark as Draft if environment-dependent checks remain unverified, and do not treat it as complete).
- Include in the PR description: linked issue(s), summary of changes and rationale, acceptance criteria status, verification results, compatibility/security impact, and any unverified items.

### 6. Subagent PR Review & Improvement Loop
- Have an independent code-reviewer subagent review the latest PR head diff against the specification, acceptance criteria, and verification results (and include a security review for security-sensitive or contract logic changes).
- Subagent reviews supplement—and do not replace—GitHub approvals or required CI checks.
- Verify each finding against the spec, reproduction steps, and tests; fix valid issues and record rationale for rejected findings.
- Repeat **fix → re-run tests & quality gates → commit & push → re-review latest head** until no valid unresolved findings remain (returning to Stages 1–2 if the specification itself must change).
- Once no valid unresolved findings remain and quality gates/CI pass on the latest head, report the PR and verification results as ready for review.
- Merging, releasing, and deploying are outside this flow and are performed only when explicitly requested.
