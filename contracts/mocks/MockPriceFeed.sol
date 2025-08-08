// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../interfaces/AggregatorV3Interface.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockPriceFeed
 * @dev テスト用のChainlinkプライスフィード
 */
contract MockPriceFeed is AggregatorV3Interface, Ownable {
    int256 private _price;
    uint8 private _decimals = 8;
    string private _description = "Mock Price Feed";
    uint256 private _version = 1;
    uint80 private _roundId = 1;
    uint256 private _startedAt;
    uint256 private _updatedAt;
    uint80 private _answeredInRound;

    constructor() {
        _price = 100000000; // $1.00 (8桁の小数点)
        _startedAt = block.timestamp;
        _updatedAt = block.timestamp;
        _answeredInRound = _roundId;
    }

    function setLatestPrice(int256 price) external onlyOwner {
        _price = price;
        _roundId++;
        _startedAt = block.timestamp;
        _updatedAt = block.timestamp;
        _answeredInRound = _roundId;
    }

    function setPriceData(
        int256 price,
        uint80 roundId,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) external onlyOwner {
        _price = price;
        _roundId = roundId;
        _startedAt = startedAt;
        _updatedAt = updatedAt;
        _answeredInRound = answeredInRound;
    }

    function setDecimals(uint8 newDecimals) external onlyOwner {
        _decimals = newDecimals;
    }

    function decimals() external view override returns (uint8) {
        return _decimals;
    }

    function description() external view override returns (string memory) {
        return _description;
    }

    function version() external view override returns (uint256) {
        return _version;
    }

    function getRoundData(uint80 roundId)
        external
        view
        override
        returns (
            uint80 roundId_,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (_roundId, _price, _startedAt, _updatedAt, _answeredInRound);
    }

    function latestRoundData()
        external
        view
        override
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (_roundId, _price, _startedAt, _updatedAt, _answeredInRound);
    }
} 