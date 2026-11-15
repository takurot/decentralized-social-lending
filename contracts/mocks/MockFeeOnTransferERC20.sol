// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockFeeOnTransferERC20
 * @notice Test ERC20 token that deducts a configurable fee (in basis points) on every transfer.
 */
contract MockFeeOnTransferERC20 is ERC20 {
    uint256 public feeBps;
    address public feeSink;

    constructor(string memory name, string memory symbol, uint256 _feeBps, address _feeSink) ERC20(name, symbol) {
        require(_feeBps <= 10000, "Fee too high");
        feeBps = _feeBps;
        feeSink = _feeSink;
        _mint(msg.sender, 1_000_000 * 1e18);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        uint256 fee = (amount * feeBps) / 10000;
        uint256 netAmount = amount - fee;
        if (fee > 0) {
            super._transfer(from, feeSink, fee);
        }
        if (netAmount > 0) {
            super._transfer(from, to, netAmount);
        }
    }
}
