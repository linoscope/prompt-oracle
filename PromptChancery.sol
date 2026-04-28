// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title PromptChancery
 * @notice Users request AI prompts, TEE-attested notary agents fulfill them
 */
contract PromptChancery {
    address public immutable kmsRoot;
    bytes32 public immutable appId;

    enum Status { Open, Committed, Fulfilled, Cancelled }

    struct Prompt {
        address requester;
        string prompt;
        uint256 createdAt;
        uint256 promptAfter;
        uint256 deadline;
        Status status;
    }

    struct Commitment {
        address notary;
    }

    struct PromptRequest {
        string prompt;
        uint256 promptAfter;
        uint256 deadline;
    }

    struct Fulfillment {
        address notary;
        string response;
        uint256 fulfilledAt;
    }

    uint256 public nextPromptId;
    mapping(uint256 => Prompt) public prompts;
    mapping(uint256 => Commitment) public commitments;
    mapping(uint256 => Fulfillment) public fulfillments;

    event PromptRequested(uint256 indexed promptId, address requester, string prompt, uint256 promptAfter, uint256 deadline);
    event PromptCommitted(uint256 indexed promptId, address notary);
    event PromptFulfilled(uint256 indexed promptId, address notary, string response);
    event PromptCancelled(uint256 indexed promptId);

    constructor(address _kmsRoot, bytes32 _appId) {
        kmsRoot = _kmsRoot;
        appId = _appId;
    }

    // --- Requester actions ---

    function submitPrompt(PromptRequest calldata request) external returns (uint256 promptId) {
        require(request.deadline > block.timestamp, "deadline must be in the future");
        require(request.promptAfter < request.deadline, "promptAfter must be before deadline");

        promptId = nextPromptId++;
        prompts[promptId] = Prompt({
            requester: msg.sender,
            prompt: request.prompt,
            createdAt: block.timestamp,
            promptAfter: request.promptAfter,
            deadline: request.deadline,
            status: Status.Open
        });

        emit PromptRequested(promptId, msg.sender, request.prompt, request.promptAfter, request.deadline);
    }

    function cancelPrompt(uint256 promptId) external {
        Prompt storage p = prompts[promptId];
        require(p.requester == msg.sender, "not requester");
        require(p.status == Status.Open, "not open");

        p.status = Status.Cancelled;
        emit PromptCancelled(promptId);
    }

    // --- Notary actions ---

    function commitToPrompt(uint256 promptId) external {
        Prompt storage p = prompts[promptId];
        require(p.status == Status.Open, "not open");
        require(block.timestamp < p.deadline, "deadline passed");

        p.status = Status.Committed;
        commitments[promptId] = Commitment({ notary: msg.sender });

        emit PromptCommitted(promptId, msg.sender);
    }

    function submitProof(
        uint256 promptId,
        string calldata response,
        bytes32 messageHash,
        bytes calldata messageSignature,
        bytes calldata appSignature,
        bytes calldata kmsSignature,
        bytes calldata derivedCompressedPubkey,
        bytes calldata appCompressedPubkey
    ) external {
        Prompt storage p = prompts[promptId];
        require(p.status == Status.Committed, "not committed");
        require(block.timestamp >= p.promptAfter, "too early");
        require(block.timestamp <= p.deadline, "deadline passed");

        Commitment storage c = commitments[promptId];
        require(c.notary == msg.sender, "not committed notary");

        // Verify TEE signature chain
        require(
            _verifySignatureChain(
                messageHash, messageSignature, appSignature, kmsSignature,
                derivedCompressedPubkey, appCompressedPubkey
            ),
            "invalid signature chain"
        );

        p.status = Status.Fulfilled;
        fulfillments[promptId] = Fulfillment({
            notary: msg.sender,
            response: response,
            fulfilledAt: block.timestamp
        });

        emit PromptFulfilled(promptId, msg.sender, response);
    }

    // --- View functions ---

    function getPrompt(uint256 promptId) external view returns (
        address requester, string memory prompt, uint256 createdAt, uint256 promptAfter, uint256 deadline, Status status
    ) {
        Prompt storage p = prompts[promptId];
        return (p.requester, p.prompt, p.createdAt, p.promptAfter, p.deadline, p.status);
    }

    function getCommitment(uint256 promptId) external view returns (address notary) {
        return commitments[promptId].notary;
    }

    function getFulfillment(uint256 promptId) external view returns (
        address notary, string memory response, uint256 fulfilledAt
    ) {
        Fulfillment storage f = fulfillments[promptId];
        return (f.notary, f.response, f.fulfilledAt);
    }

    function isExpired(uint256 promptId) external view returns (bool) {
        Prompt storage p = prompts[promptId];
        return block.timestamp > p.deadline && p.status != Status.Fulfilled;
    }

    // --- TEE Signature Chain Verification (inline from TeeVerifier) ---

    function _verifySignatureChain(
        bytes32 messageHash,
        bytes calldata messageSignature,
        bytes calldata appSignature,
        bytes calldata kmsSignature,
        bytes calldata derivedCompressedPubkey,
        bytes calldata appCompressedPubkey
    ) internal view returns (bool) {
        // Step 1: Verify app signature over derived key
        string memory derivedHex = _bytesToHex(derivedCompressedPubkey);
        string memory appMessage = string(abi.encodePacked("ethereum:", derivedHex));
        bytes32 appMessageHash = keccak256(bytes(appMessage));
        address recoveredApp = _recoverSigner(appMessageHash, appSignature);

        // Step 2: Verify KMS signature over app key
        bytes memory kmsMessage = abi.encodePacked(
            "dstack-kms-issued:",
            bytes20(appId),
            appCompressedPubkey
        );
        bytes32 kmsMessageHash = keccak256(kmsMessage);
        address recoveredKms = _recoverSigner(kmsMessageHash, kmsSignature);

        if (recoveredKms != kmsRoot) return false;

        // Step 3: Verify message signature
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        address messageSigner = _recoverSigner(ethHash, messageSignature);

        // Verify message signer matches derived key
        address derivedAddress = _compressedPubkeyToAddress(derivedCompressedPubkey);
        if (messageSigner != derivedAddress) return false;

        // Verify app key matches recovered app signer
        address appAddress = _compressedPubkeyToAddress(appCompressedPubkey);
        if (recoveredApp != appAddress) return false;

        return true;
    }

    function _recoverSigner(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "bad sig len");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        return ecrecover(hash, v, r, s);
    }

    function _compressedPubkeyToAddress(bytes calldata pubkey) internal view returns (address) {
        require(pubkey.length == 33, "need compressed pubkey");
        uint8 prefix = uint8(pubkey[0]);
        require(prefix == 0x02 || prefix == 0x03, "invalid prefix");

        uint256 x;
        assembly {
            x := calldataload(add(pubkey.offset, 1))
        }

        uint256 p = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;
        uint256 y2 = addmod(mulmod(mulmod(x, x, p), x, p), 7, p);
        uint256 y = _modExp(y2, (p + 1) / 4, p);

        if ((prefix == 0x02 && y % 2 != 0) || (prefix == 0x03 && y % 2 == 0)) {
            y = p - y;
        }

        bytes32 hash = keccak256(abi.encodePacked(x, y));
        return address(uint160(uint256(hash)));
    }

    function _modExp(uint256 base, uint256 exp, uint256 mod) internal view returns (uint256) {
        bytes memory input = abi.encodePacked(
            uint256(32), uint256(32), uint256(32),
            base, exp, mod
        );
        bytes memory output = new bytes(32);
        assembly {
            if iszero(staticcall(gas(), 0x05, add(input, 32), 192, add(output, 32), 32)) {
                revert(0, 0)
            }
        }
        return abi.decode(output, (uint256));
    }

    function _bytesToHex(bytes calldata data) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory str = new bytes(data.length * 2); 
        for (uint i = 0; i < data.length; i++) {
            str[i*2] = alphabet[uint8(data[i] >> 4)];
            str[i*2+1] = alphabet[uint8(data[i] & 0x0f)];
        }
        return string(str);
    }
}
