// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SpendingPolicy.sol";

contract SpendingPolicyTest is Test {
    SpendingPolicy policy;
    address alice = address(0xA11CE);

    function setUp() external {
        policy = new SpendingPolicy(address(this));
    }

    // ── Basic limits ─────────────────────────────────────────────────

    function testDailyLimitAndRecord() external {
        bytes32 key = keccak256("oracle");
        policy.setDailyLimit(key, 10 ether);
        assertEq(policy.remaining(key), 10 ether);

        policy.recordSpend(key, 3 ether);
        assertEq(policy.remaining(key), 7 ether);
    }

    function testSetLimitEmitsEvent() external {
        bytes32 key = keccak256("news");
        vm.expectEmit(true, false, false, true);
        emit SpendingPolicy.LimitSet(key, 5 ether);
        policy.setDailyLimit(key, 5 ether);
    }

    function testRecordSpendEmitsEvent() external {
        bytes32 key = keccak256("oracle");
        policy.setDailyLimit(key, 10 ether);
        vm.expectEmit(true, false, false, true);
        emit SpendingPolicy.SpendRecorded(key, 2 ether, 2 ether, 2 ether);
        policy.recordSpend(key, 2 ether);
    }

    // ── Enforcement ──────────────────────────────────────────────────

    function testCannotExceedDailyLimit() external {
        bytes32 key = keccak256("oracle");
        policy.setDailyLimit(key, 5 ether);
        policy.recordSpend(key, 4 ether);

        vm.expectRevert(
            abi.encodeWithSelector(
                SpendingPolicy.ExceedsDailyLimit.selector,
                1 ether,    // remaining
                2 ether     // requested
            )
        );
        policy.recordSpend(key, 2 ether);
    }

    function testCanSpendReturnsCorrectly() external {
        bytes32 key = keccak256("yield");
        policy.setDailyLimit(key, 10 ether);
        assertTrue(policy.canSpend(key, 10 ether));
        assertFalse(policy.canSpend(key, 11 ether));
        policy.recordSpend(key, 6 ether);
        assertTrue(policy.canSpend(key, 4 ether));
        assertFalse(policy.canSpend(key, 5 ether));
    }

    // ── Daily Reset ──────────────────────────────────────────────────

    function testDailyResetResetsSpent() external {
        bytes32 key = keccak256("oracle");
        policy.setDailyLimit(key, 10 ether);
        policy.recordSpend(key, 8 ether);
        assertEq(policy.remaining(key), 2 ether);

        // Fast-forward 1 day
        vm.warp(block.timestamp + 1 days);
        assertEq(policy.remaining(key), 10 ether);

        // Record should work again after reset
        policy.recordSpend(key, 5 ether);
        assertEq(policy.remaining(key), 5 ether);
    }

    function testTotalSpentPersistsAcrossDays() external {
        bytes32 key = keccak256("oracle");
        policy.setDailyLimit(key, 10 ether);
        policy.recordSpend(key, 3 ether);

        vm.warp(block.timestamp + 1 days);
        policy.recordSpend(key, 4 ether);

        SpendingPolicy.Limit memory l = policy.getStatus(key);
        assertEq(l.totalSpentWei, 7 ether);
    }

    // ── Access Control ────────────────────────────────────────────────

    function testNonAdminCannotSetLimit() external {
        vm.prank(alice);
        vm.expectRevert(SpendingPolicy.NotAdmin.selector);
        policy.setDailyLimit(keccak256("rogue"), 1 ether);
    }

    function testNonAdminCannotRecordSpend() external {
        bytes32 key = keccak256("oracle");
        policy.setDailyLimit(key, 10 ether);
        vm.prank(alice);
        vm.expectRevert(SpendingPolicy.NotAdmin.selector);
        policy.recordSpend(key, 1 ether);
    }

    // ── Edge cases ───────────────────────────────────────────────────

    function testUninitializedLimitReverts() external {
        vm.expectRevert(SpendingPolicy.LimitNotInitialized.selector);
        policy.remaining(keccak256("nonexistent"));
    }

    function testExactLimitSpendSucceeds() external {
        bytes32 key = keccak256("exact");
        policy.setDailyLimit(key, 1 ether);
        policy.recordSpend(key, 1 ether);
        assertEq(policy.remaining(key), 0);
    }
}
