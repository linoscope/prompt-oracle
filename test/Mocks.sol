// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { IERC20, IPromptChancery } from "../BetMarket.sol";

contract MockERC20 is IERC20 {
    mapping(address => uint256) public balances;
    mapping(address => mapping(address => uint256)) public allowances;

    function mint(address to, uint256 amount) external {
        balances[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowances[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balances[msg.sender] >= amount, "insufficient balance");
        balances[msg.sender] -= amount;
        balances[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balances[from] >= amount, "insufficient balance");
        require(allowances[from][msg.sender] >= amount, "insufficient allowance");
        balances[from] -= amount;
        balances[to] += amount;
        allowances[from][msg.sender] -= amount;
        return true;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }
}

contract MockPromptChancery is IPromptChancery {
    struct StoredPrompt {
        string prompt;
        uint256 promptAfter;
        uint256 deadline;
    }

    struct StoredFulfillment {
        address notary;
        string response;
        uint256 fulfilledAt;
    }

    uint256 public nextPromptId;
    mapping(uint256 => StoredPrompt) public prompts;
    mapping(uint256 => StoredFulfillment) public fulfillments;

    function submitPrompt(PromptRequest calldata request) external returns (uint256 promptId) {
        promptId = nextPromptId++;
        prompts[promptId] = StoredPrompt({
            prompt: request.prompt,
            promptAfter: request.promptAfter,
            deadline: request.deadline
        });
    }

    /// @notice Test helper: pretend the notary fulfilled the prompt.
    function mockFulfill(uint256 promptId, string calldata response) external {
        fulfillments[promptId] = StoredFulfillment({
            notary: address(0xB00B),
            response: response,
            fulfilledAt: block.timestamp
        });
    }

    function getFulfillment(uint256 promptId) external view returns (
        address notary,
        string memory response,
        uint256 fulfilledAt
    ) {
        StoredFulfillment storage f = fulfillments[promptId];
        return (f.notary, f.response, f.fulfilledAt);
    }
}
