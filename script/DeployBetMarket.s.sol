// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Script.sol";
import { BetMarket, IERC20, IPromptChancery } from "../BetMarket.sol";

/**
 * @notice Deploy BetMarket against the live PromptChancery + USDC on Base.
 *
 * Usage:
 *   PRIVATE_KEY=0x... forge script script/DeployBetMarket.s.sol \
 *     --rpc-url https://mainnet.base.org --broadcast
 */
contract DeployBetMarket is Script {
    // Base mainnet
    address constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant PROMPT_CHANCERY = 0xE453E01aEF962A836a0B78AbB91a18f01C3d8160;

    function run() external returns (BetMarket bm) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);

        bm = new BetMarket(IERC20(BASE_USDC), IPromptChancery(PROMPT_CHANCERY));

        vm.stopBroadcast();

        console.log("BetMarket deployed at:", address(bm));
        console.log("  USDC:           ", BASE_USDC);
        console.log("  PromptChancery: ", PROMPT_CHANCERY);
    }
}
