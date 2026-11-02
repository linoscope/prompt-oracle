// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import { PromptChancery } from "../PromptChancery.sol";

/// @notice submitProof tests with a locally built dstack signature chain:
/// KMS root key → app key → TEE-derived key, signed the same way the Notary
/// Core and dstack KMS sign in production.
contract PromptChanceryTest is Test {
    PromptChancery chancery;

    uint256 constant KMS_PK = 0xA11CE;
    uint256 constant APP_PK = 0xB0B;
    uint256 constant DERIVED_PK = 0xC0FFEE;
    bytes32 constant APP_ID = bytes32(bytes20(hex"986f5ce6e7a5a4f393a292481ef411748f5b8c13"));

    address requester = makeAddr("requester");
    address notary = makeAddr("notary");
    address attacker = makeAddr("attacker");

    string constant PROMPT = "Did flight XY 123 on 14 Nov land more than 2 hours late? Answer YES or NO.";

    uint256 promptId;
    uint256 promptAfter;
    uint256 deadline;

    bytes derivedPub;
    bytes appPub;
    bytes appSig;
    bytes kmsSig;

    function setUp() public {
        vm.warp(1_700_000_000);
        chancery = new PromptChancery(vm.addr(KMS_PK), APP_ID);

        derivedPub = _compressedPubkey(DERIVED_PK);
        appPub = _compressedPubkey(APP_PK);
        appSig = _sign(APP_PK, keccak256(abi.encodePacked("ethereum:", _hexNoPrefix(derivedPub))));
        kmsSig = _sign(KMS_PK, keccak256(abi.encodePacked("dstack-kms-issued:", bytes20(APP_ID), appPub)));

        promptAfter = block.timestamp + 1 hours;
        deadline = block.timestamp + 1 days;
        vm.prank(requester);
        promptId = chancery.submitPrompt(PromptChancery.PromptRequest({
            prompt: PROMPT,
            promptAfter: promptAfter,
            deadline: deadline
        }));
    }

    function test_SubmitProof_AcceptsGenuineAnswer() public {
        vm.prank(notary);
        chancery.commitToPrompt(promptId);
        vm.warp(promptAfter + 10);

        uint256 ts = (promptAfter + 5) * 1000;
        (bytes32 hash, bytes memory sig) = _teeAnswer(PROMPT, "NO", ts);
        vm.prank(notary);
        _submitProof(promptId, "NO", ts, hash, sig);

        (address fulfiller, string memory response,) = chancery.getFulfillment(promptId);
        assertEq(fulfiller, notary);
        assertEq(response, "NO");
    }

    /// The exploit: commit, get any genuine TEE signature from the public
    /// /prompt endpoint, then submit it alongside a response of your choice.
    function test_SubmitProof_RejectsResponseSignedForAnotherPrompt() public {
        vm.prank(attacker);
        chancery.commitToPrompt(promptId);
        vm.warp(promptAfter + 10);

        uint256 ts = (promptAfter + 5) * 1000;
        (bytes32 hash, bytes memory sig) = _teeAnswer("hello", "Hi there!", ts);
        vm.prank(attacker);
        vm.expectRevert("invalid signature chain");
        _submitProof(promptId, "YES", ts, hash, sig);
    }

    function test_SubmitProof_RejectsResponseSwappedOnSamePrompt() public {
        vm.prank(attacker);
        chancery.commitToPrompt(promptId);
        vm.warp(promptAfter + 10);

        uint256 ts = (promptAfter + 5) * 1000;
        (bytes32 hash, bytes memory sig) = _teeAnswer(PROMPT, "NO", ts);
        vm.prank(attacker);
        vm.expectRevert("invalid signature chain");
        _submitProof(promptId, "YES", ts, hash, sig);
    }

    /// An answer fetched before promptAfter can't be held back and submitted
    /// once the window opens.
    function test_SubmitProof_RejectsAnswerSignedBeforePromptAfter() public {
        vm.prank(notary);
        chancery.commitToPrompt(promptId);

        uint256 ts = (promptAfter - 60) * 1000;
        (bytes32 hash, bytes memory sig) = _teeAnswer(PROMPT, "NO", ts);
        vm.warp(promptAfter + 10);
        vm.prank(notary);
        vm.expectRevert("answered too early");
        _submitProof(promptId, "NO", ts, hash, sig);
    }

    // --- Helpers ---

    /// The hash the TEE signed is not passed: the contract rebuilds it from the
    /// stored prompt, the response and the timestamp.
    function _submitProof(uint256 id, string memory response, uint256 tsMs, bytes32, bytes memory sig) internal {
        chancery.submitProof(id, response, tsMs, sig, appSig, kmsSig, derivedPub, appPub);
    }

    /// Mirrors the Notary Core: keccak256(prompt, response, timestamp in ms),
    /// signed as an EIP-191 message by the TEE-derived key.
    function _teeAnswer(string memory prompt, string memory response, uint256 tsMs)
        internal
        pure
        returns (bytes32 hash, bytes memory sig)
    {
        hash = keccak256(abi.encodePacked(prompt, response, tsMs));
        sig = _sign(DERIVED_PK, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash)));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _compressedPubkey(uint256 pk) internal returns (bytes memory) {
        Vm.Wallet memory w = vm.createWallet(pk);
        return abi.encodePacked(w.publicKeyY % 2 == 0 ? bytes1(0x02) : bytes1(0x03), bytes32(w.publicKeyX));
    }

    function _hexNoPrefix(bytes memory data) internal pure returns (string memory) {
        bytes memory prefixed = bytes(vm.toString(data));
        bytes memory out = new bytes(prefixed.length - 2);
        for (uint256 i = 0; i < out.length; i++) out[i] = prefixed[i + 2];
        return string(out);
    }
}
