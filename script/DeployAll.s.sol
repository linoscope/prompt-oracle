// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Script.sol";
import { PromptChancery } from "../PromptChancery.sol";
import { BetMarket, IERC20, IPromptChancery } from "../BetMarket.sol";

/**
 * @notice Deploy a fresh PromptChancery (anchored to a Notary Core app id) and
 *         a BetMarket on top of it, against USDC on Base.
 *
 * Usage:
 *   PRIVATE_KEY=0x... APP_ID=0x<20-byte app id> forge script script/DeployAll.s.sol \
 *     --rpc-url https://mainnet.base.org --broadcast
 *
 * KMS_ROOT defaults to the Phala Base KMS root; override only if it rotated.
 */
contract DeployAll is Script {
    // Base mainnet
    address constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant BASE_KMS_ROOT = 0x52d3CF51c8A37A2CCfC79bBb98c7810d7Dd4CE51;

    function run() external returns (PromptChancery pc, BetMarket bm) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address appId = vm.envAddress("APP_ID");
        address kmsRoot = vm.envOr("KMS_ROOT", BASE_KMS_ROOT);

        vm.startBroadcast(pk);

        pc = new PromptChancery(kmsRoot, bytes32(bytes20(appId)));
        bm = new BetMarket(IERC20(BASE_USDC), IPromptChancery(address(pc)));

        vm.stopBroadcast();

        console.log("PromptChancery deployed at:", address(pc));
        console.log("  KMS root:       ", kmsRoot);
        console.log("  App id:         ", appId);
        console.log("BetMarket deployed at:     ", address(bm));
        console.log("  USDC:           ", BASE_USDC);
    }
}
