// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title MockRevertingReceiver
 * @notice Test helper contract that can revert or burn gas when receiving ETH.
 */
contract MockRevertingReceiver {
    bool public shouldRevert = true;
    bool public burnGas;

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function setBurnGas(bool _burnGas) external {
        burnGas = _burnGas;
    }

    receive() external payable {
        if (burnGas) {
            while (gasleft() > 0) {}
        }
        if (shouldRevert) {
            revert("ETH rejected");
        }
    }

    function callContract(address target, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: msg.value}(data);
        require(ok, "Forward call failed");
        return ret;
    }
}
