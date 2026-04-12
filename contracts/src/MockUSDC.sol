// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal mintable ERC-20 for testnet demo payments ("USDC").
contract MockUSDC {
    string public constant name = "Mock USDC";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    address public immutable admin;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    error NotAdmin();
    error InsufficientBalance();
    error InsufficientAllowance();
    error InvalidAddress();

    constructor(address _admin) {
        admin = _admin == address(0) ? msg.sender : _admin;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (spender == address(0)) revert InvalidAddress();
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a < amount) revert InsufficientAllowance();
        allowance[from][msg.sender] = a - amount;
        _transfer(from, to, amount);
        return true;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != admin) revert NotAdmin();
        if (to == address(0)) revert InvalidAddress();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert InvalidAddress();
        uint256 b = balanceOf[from];
        if (b < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = b - amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

