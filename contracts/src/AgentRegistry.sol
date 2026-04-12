// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal on-chain Agent Registry for Kairos (EVM / Four.meme Sprint demo).
/// Stores agent metadata needed for agentic commerce: owner payout address, price, reputation, and usage.
contract AgentRegistry {
    struct Agent {
        bytes32 key; // canonical agent key, e.g. keccak256("oracle")
        address owner; // payout address (EOA)
        string name;
        string serviceType;
        uint256 priceWei; // native BNB amount per task (in wei)
        uint32 reputation; // arbitrary score (e.g. 0-1000)
        uint32 tasksCompleted;
        bool active;
    }

    address public immutable admin;

    mapping(bytes32 => Agent) private agentsByKey;
    bytes32[] private agentKeys;

    event AgentRegistered(bytes32 indexed key, address indexed owner, string serviceType, uint256 priceWei);
    event AgentUpdated(bytes32 indexed key, address indexed owner, uint256 priceWei, bool active);
    event ReputationUpdated(bytes32 indexed key, uint32 reputation, uint32 tasksCompleted);

    error NotAdmin();
    error AgentAlreadyExists();
    error AgentNotFound();
    error InvalidOwner();
    error InvalidPrice();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address _admin) {
        admin = _admin == address(0) ? msg.sender : _admin;
    }

    function registerAgent(
        bytes32 key,
        address owner,
        string calldata name,
        string calldata serviceType,
        uint256 priceWei
    ) external onlyAdmin {
        if (owner == address(0)) revert InvalidOwner();
        if (priceWei == 0) revert InvalidPrice();
        if (agentsByKey[key].owner != address(0)) revert AgentAlreadyExists();

        agentsByKey[key] = Agent({
            key: key,
            owner: owner,
            name: name,
            serviceType: serviceType,
            priceWei: priceWei,
            reputation: 100,
            tasksCompleted: 0,
            active: true
        });
        agentKeys.push(key);
        emit AgentRegistered(key, owner, serviceType, priceWei);
    }

    function updateAgent(bytes32 key, address owner, uint256 priceWei, bool active) external onlyAdmin {
        Agent storage a = agentsByKey[key];
        if (a.owner == address(0)) revert AgentNotFound();
        if (owner == address(0)) revert InvalidOwner();
        if (priceWei == 0) revert InvalidPrice();

        a.owner = owner;
        a.priceWei = priceWei;
        a.active = active;
        emit AgentUpdated(key, owner, priceWei, active);
    }

    /// @notice Called by trusted backend to update reputation/usage counters.
    function updateReputation(bytes32 key, uint32 reputation, uint32 tasksCompleted) external onlyAdmin {
        Agent storage a = agentsByKey[key];
        if (a.owner == address(0)) revert AgentNotFound();
        a.reputation = reputation;
        a.tasksCompleted = tasksCompleted;
        emit ReputationUpdated(key, reputation, tasksCompleted);
    }

    function getAgent(bytes32 key) external view returns (Agent memory) {
        Agent memory a = agentsByKey[key];
        if (a.owner == address(0)) revert AgentNotFound();
        return a;
    }

    function listAgentKeys() external view returns (bytes32[] memory) {
        return agentKeys;
    }
}

