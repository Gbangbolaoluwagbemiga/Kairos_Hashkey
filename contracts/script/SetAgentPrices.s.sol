// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/AgentRegistry.sol";

/// @notice Set per-task priceWei for all 9 agents (keeps owner + active).
contract SetAgentPrices is Script {
    function run() external {
        address registryAddr = vm.envOr("KAIROS_AGENT_REGISTRY", address(0));
        if (registryAddr == address(0)) registryAddr = vm.envOr("KAIROS_AGENT_REGISTRY_EVM_ADDRESS", address(0));
        if (registryAddr == address(0)) registryAddr = 0x7e7b5dbaE3aDb3D94a27DCfB383bDB98667145E6;

        uint256 priceWei = vm.envOr("KAIROS_DEFAULT_AGENT_PRICE_WEI", uint256(5e14)); // 0.0005 BNB

        AgentRegistry registry = AgentRegistry(registryAddr);

        vm.startBroadcast();
        _set(registry, "oracle", priceWei);
        _set(registry, "news", priceWei);
        _set(registry, "yield", priceWei);
        _set(registry, "tokenomics", priceWei);
        _set(registry, "perp", priceWei);
        _set(registry, "protocol", priceWei);
        _set(registry, "bridges", priceWei);
        _set(registry, "dex-volumes", priceWei);
        _set(registry, "chain-scout", priceWei);
        vm.stopBroadcast();
    }

    function _set(AgentRegistry registry, string memory key, uint256 newPriceWei) internal {
        bytes32 k = keccak256(bytes(key));
        AgentRegistry.Agent memory a = registry.getAgent(k);
        registry.updateAgent(k, a.owner, newPriceWei, a.active);
        console2.log("updated price:", key, newPriceWei);
    }
}

