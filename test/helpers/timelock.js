const { ethers, network } = require("hardhat");

const TIMELOCK_DELAY = 48 * 60 * 60;
const TIMELOCKED_SETTERS = {
    setCollateralTokenStatus: ["address", "bool"],
    setCollateralTokenDecimals: ["address", "uint8"],
    setPriceFeed: ["address", "address"],
    setPriceFeedTimeout: ["address", "uint256"],
    setPlatformFee: ["uint256"],
    setFeeRecipient: ["address"],
    setCollateralRatio: ["uint256"],
    setGracePeriod: ["uint256"],
    setLiquidationThreshold: ["uint256"],
};

async function refreshPriceFeed(feedOrAddr) {
    if (!feedOrAddr) return;
    const feed =
        typeof feedOrAddr === "string"
            ? await ethers.getContractAt("MockPriceFeed", feedOrAddr)
            : feedOrAddr;
    if (typeof feed.refreshTimestamp === "function") {
        try {
            await feed.refreshTimestamp();
            return;
        } catch {
            // ignore if not a MockPriceFeed
        }
    }
    if (typeof feed.latestRoundData === "function" && typeof feed.setLatestPrice === "function") {
        try {
            const [, answer] = await feed.latestRoundData();
            await feed.setLatestPrice(answer);
        } catch {
            // ignore
        }
    }
}

async function execTimelocked(lending, fnName, args, feeds = []) {
    const types = TIMELOCKED_SETTERS[fnName];
    if (!types) {
        return lending[fnName](...args);
    }
    const selector = lending.interface.getFunction(fnName).selector;
    const resolvedArgs = await Promise.all(args);
    const params = ethers.AbiCoder.defaultAbiCoder().encode(types, resolvedArgs);
    await lending.queueChange(selector, params);
    await network.provider.send("evm_increaseTime", [TIMELOCK_DELAY + 1]);
    await network.provider.send("evm_mine");
    for (const feed of feeds) {
        await refreshPriceFeed(feed);
    }
    if (fnName === "setPriceFeed" && resolvedArgs[1] && resolvedArgs[1] !== ethers.ZeroAddress) {
        await refreshPriceFeed(resolvedArgs[1]);
    }
    return lending[fnName](...resolvedArgs);
}

/**
 * Wraps a deployed SocialLendingWithCollateral instance so direct calls to
 * timelocked admin setters from the owner automatically queueChange + advance
 * 48 hours + refresh provided MockPriceFeed instances when parameters are valid.
 * Calls from non-owners or with invalid parameters/addresses still call the
 * underlying contract directly so fail-fast revert tests work unchanged.
 */
function wrapWithTimelock(lending, feeds = []) {
    return new Proxy(lending, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (prop === "connect" && typeof value === "function") {
                return (signer) => {
                    const connected = value.call(target, signer);
                    return wrapWithTimelock(connected, feeds);
                };
            }
            if (typeof prop === "string" && TIMELOCKED_SETTERS[prop] && typeof value === "function") {
                return async (...args) => {
                    // Probe staticCall first: if it reverts with anything OTHER than ChangeNotQueued
                    // (e.g., Ownable, InvalidParameter, InvalidAddress, StaleData, CollateralLocked),
                    // execute directly so the caller's expect(...).to.be.reverted* sees the exact revert!
                    const resolvedArgs = await Promise.all(args);
                    try {
                        await target[prop].staticCall(...resolvedArgs);
                    } catch (err) {
                        const msg = (err && (err.message || String(err))) || "";
                        if (!msg.includes("ChangeNotQueued")) {
                            return value.apply(target, resolvedArgs);
                        }
                    }
                    return execTimelocked(target, prop, resolvedArgs, feeds);
                };
            }
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

module.exports = {
    TIMELOCK_DELAY,
    TIMELOCKED_SETTERS,
    execTimelocked,
    wrapWithTimelock,
};
