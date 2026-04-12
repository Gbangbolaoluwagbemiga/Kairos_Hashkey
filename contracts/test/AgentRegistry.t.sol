// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/AgentRegistry.sol";

contract AgentRegistryTest is Test {
    AgentRegistry registry;
    address alice = address(0xA11CE);
    address bob   = address(0xB0B);

    function setUp() external {
        registry = new AgentRegistry(address(this));
    }

    // ── Registration ─────────────────────────────────────────────────

    function testRegisterAndGet() external {
        bytes32 key = keccak256("oracle");
        registry.registerAgent(key, address(0xBEEF), "Price Oracle", "price", 1e15);
        AgentRegistry.Agent memory a = registry.getAgent(key);
        assertEq(a.owner, address(0xBEEF));
        assertEq(a.priceWei, 1e15);
        assertTrue(a.active);
        assertEq(a.reputation, 100);
        assertEq(a.tasksCompleted, 0);
    }

    function testRegisterEmitsEvent() external {
        bytes32 key = keccak256("news");
        vm.expectEmit(true, true, false, true);
        emit AgentRegistry.AgentRegistered(key, alice, "news", 5e14);
        registry.registerAgent(key, alice, "News Scout", "news", 5e14);
    }

    function testCannotRegisterDuplicate() external {
        bytes32 key = keccak256("yield");
        registry.registerAgent(key, alice, "Yield", "yield", 1e15);
        vm.expectRevert(AgentRegistry.AgentAlreadyExists.selector);
        registry.registerAgent(key, bob, "Yield 2", "yield", 1e15);
    }

    function testCannotRegisterZeroOwner() external {
        bytes32 key = keccak256("bad");
        vm.expectRevert(AgentRegistry.InvalidOwner.selector);
        registry.registerAgent(key, address(0), "Bad", "bad", 1e15);
    }

    function testCannotRegisterZeroPrice() external {
        bytes32 key = keccak256("free");
        vm.expectRevert(AgentRegistry.InvalidPrice.selector);
        registry.registerAgent(key, alice, "Free", "free", 0);
    }

    // ── Access Control ────────────────────────────────────────────────

    function testNonAdminCannotRegister() external {
        bytes32 key = keccak256("rogue");
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.NotAdmin.selector);
        registry.registerAgent(key, alice, "Rogue", "rogue", 1e15);
    }

    function testNonAdminCannotUpdate() external {
        bytes32 key = keccak256("oracle");
        registry.registerAgent(key, alice, "Oracle", "price", 1e15);
        vm.prank(bob);
        vm.expectRevert(AgentRegistry.NotAdmin.selector);
        registry.updateAgent(key, bob, 2e15, true);
    }

    // ── Updates ───────────────────────────────────────────────────────

    function testUpdateAgentFields() external {
        bytes32 key = keccak256("oracle");
        registry.registerAgent(key, alice, "Oracle", "price", 1e15);
        registry.updateAgent(key, bob, 2e15, false);
        AgentRegistry.Agent memory a = registry.getAgent(key);
        assertEq(a.owner, bob);
        assertEq(a.priceWei, 2e15);
        assertFalse(a.active);
    }

    function testUpdateReputationEmitsEvent() external {
        bytes32 key = keccak256("oracle");
        registry.registerAgent(key, alice, "Oracle", "price", 1e15);
        vm.expectEmit(true, false, false, true);
        emit AgentRegistry.ReputationUpdated(key, 250, 42);
        registry.updateReputation(key, 250, 42);
        AgentRegistry.Agent memory a = registry.getAgent(key);
        assertEq(a.reputation, 250);
        assertEq(a.tasksCompleted, 42);
    }

    function testGetNonexistentReverts() external {
        vm.expectRevert(AgentRegistry.AgentNotFound.selector);
        registry.getAgent(keccak256("ghost"));
    }

    // ── Listing ──────────────────────────────────────────────────────

    function testListAgentKeys() external {
        bytes32 k1 = keccak256("oracle");
        bytes32 k2 = keccak256("news");
        registry.registerAgent(k1, alice, "Oracle", "price", 1e15);
        registry.registerAgent(k2, bob, "News", "news", 5e14);
        bytes32[] memory keys = registry.listAgentKeys();
        assertEq(keys.length, 2);
        assertEq(keys[0], k1);
        assertEq(keys[1], k2);
    }
}
