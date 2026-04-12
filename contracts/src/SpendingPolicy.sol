// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Simple daily spending limit policy for agent wallets.
/// For hackathon realism, a trusted backend (admin) records spends for each agent key after sending funds.
contract SpendingPolicy {
    struct Limit {
        uint256 dailyLimitWei;
        uint256 spentTodayWei;
        uint64 periodStart; // unix seconds at start of current day bucket
        uint256 totalSpentWei;
    }

    address public immutable admin;

    mapping(bytes32 => Limit) private limits;

    event LimitSet(bytes32 indexed agentKey, uint256 dailyLimitWei);
    event SpendRecorded(bytes32 indexed agentKey, uint256 amountWei, uint256 spentTodayWei, uint256 totalSpentWei);

    error NotAdmin();
    error LimitNotInitialized();
    error ExceedsDailyLimit(uint256 remainingWei, uint256 requestedWei);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address _admin) {
        admin = _admin == address(0) ? msg.sender : _admin;
    }

    function _dayStart(uint256 ts) internal pure returns (uint64) {
        // UTC day bucket
        return uint64((ts / 1 days) * 1 days);
    }

    function setDailyLimit(bytes32 agentKey, uint256 dailyLimitWei) external onlyAdmin {
        Limit storage l = limits[agentKey];
        // periodStart may be 0 at unix epoch; initialization is keyed off dailyLimitWei instead.
        if (l.dailyLimitWei == 0) l.periodStart = _dayStart(block.timestamp);
        l.dailyLimitWei = dailyLimitWei;
        emit LimitSet(agentKey, dailyLimitWei);
    }

    function getStatus(bytes32 agentKey) external view returns (Limit memory) {
        Limit memory l = limits[agentKey];
        if (l.dailyLimitWei == 0) revert LimitNotInitialized();
        // View does not auto-reset; backend should call `remaining()` before recording.
        return l;
    }

    function remaining(bytes32 agentKey) public view returns (uint256 remainingWei) {
        Limit memory l = limits[agentKey];
        if (l.dailyLimitWei == 0) revert LimitNotInitialized();
        uint64 today = _dayStart(block.timestamp);
        uint256 spent = (l.periodStart == today) ? l.spentTodayWei : 0;
        if (spent >= l.dailyLimitWei) return 0;
        return l.dailyLimitWei - spent;
    }

    function canSpend(bytes32 agentKey, uint256 amountWei) external view returns (bool) {
        return amountWei <= remaining(agentKey);
    }

    /// @notice Records an agent spend. Reverts if it would exceed the daily limit.
    function recordSpend(bytes32 agentKey, uint256 amountWei) external onlyAdmin {
        Limit storage l = limits[agentKey];
        if (l.dailyLimitWei == 0) revert LimitNotInitialized();

        uint64 today = _dayStart(block.timestamp);
        if (l.periodStart != today) {
            l.periodStart = today;
            l.spentTodayWei = 0;
        }

        uint256 rem = l.dailyLimitWei - l.spentTodayWei;
        if (amountWei > rem) revert ExceedsDailyLimit(rem, amountWei);

        l.spentTodayWei += amountWei;
        l.totalSpentWei += amountWei;

        emit SpendRecorded(agentKey, amountWei, l.spentTodayWei, l.totalSpentWei);
    }
}

