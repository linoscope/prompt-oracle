// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IPromptChancery {
    struct PromptRequest {
        string prompt;
        uint256 promptAfter;
        uint256 deadline;
    }

    function submitPrompt(PromptRequest calldata request) external returns (uint256 promptId);

    function getFulfillment(uint256 promptId) external view returns (
        address notary,
        string memory response,
        uint256 fulfilledAt
    );
}

/**
 * @title BetMarket
 * @notice 1v1 prediction market resolved by a TEE-attested PromptChancery oracle.
 *         Two parties lock USDC against a yes/no question; the contract reads the
 *         oracle's verdict and pays out the winner, or refunds both on UNDECIDED
 *         / oracle timeout.
 */
contract BetMarket {
    IERC20 public immutable usdc;
    IPromptChancery public immutable chancery;

    // The static instruction block is the same for every bet. The per-bet
    // context (matched / earliest-resolution / deadline timestamps) is
    // appended dynamically inside acceptBet so the LLM can resolve questions
    // phrased in terms of "since the bet was matched" without the user having
    // to bake absolute UTC timestamps into the question text.
    string constant WRAPPER_PREFIX =
        "Answer the following question. Output exactly two parts. "
        "Line 1: one word, either YES, NO, or UNDECIDED. "
        "Line 2 onwards: your reasoning.\n\n";

    enum Status {
        Open,         // creator escrowed, awaiting taker
        Matched,      // both escrowed, prompt submitted to chancery
        ResolvedYes,  // creator wins
        ResolvedNo,   // taker wins
        Refunded,     // UNDECIDED, oracle timeout, or unparseable response
        Cancelled     // creator pulled out before match
    }

    struct Bet {
        address creator;
        address taker;          // 0x0 until Matched
        uint128 creatorStake;
        uint128 takerStake;
        string  title;          // short label for UI lists; not sent to the oracle
        string  question;       // full text sent to the oracle (after wrapping)
        uint64  promptAfter;
        uint64  deadline;
        uint64  createdAt;
        uint64  matchedAt;
        uint256 promptId;       // set on accept
        Status  status;
    }

    uint256 public nextBetId;
    mapping(uint256 => Bet) public bets;

    event BetCreated(
        uint256 indexed betId,
        address indexed creator,
        string  title,
        string  question,
        uint64  promptAfter,
        uint64  deadline,
        uint128 creatorStake,
        uint128 takerStake
    );
    event BetAccepted(uint256 indexed betId, address indexed taker, uint256 promptId);
    event BetCancelled(uint256 indexed betId);
    event BetResolved(uint256 indexed betId, Status status, string response);

    constructor(IERC20 _usdc, IPromptChancery _chancery) {
        usdc = _usdc;
        chancery = _chancery;
    }

    // --- Creator actions ---

    function createBet(
        string  calldata title,
        string  calldata question,
        uint64  promptAfter,
        uint64  deadline,
        uint128 creatorStake,
        uint128 takerStake
    ) external returns (uint256 betId) {
        require(deadline > promptAfter, "deadline must follow promptAfter");
        require(promptAfter > block.timestamp, "promptAfter must be in the future");
        require(creatorStake > 0 && takerStake > 0, "stakes must be > 0");

        require(usdc.transferFrom(msg.sender, address(this), creatorStake), "USDC transferFrom failed");

        betId = nextBetId++;
        bets[betId] = Bet({
            creator: msg.sender,
            taker: address(0),
            creatorStake: creatorStake,
            takerStake: takerStake,
            title: title,
            question: question,
            promptAfter: promptAfter,
            deadline: deadline,
            createdAt: uint64(block.timestamp),
            matchedAt: 0,
            promptId: 0,
            status: Status.Open
        });

        emit BetCreated(betId, msg.sender, title, question, promptAfter, deadline, creatorStake, takerStake);
    }

    function cancel(uint256 betId) external {
        Bet storage b = bets[betId];
        require(b.creator == msg.sender, "not creator");
        require(b.status == Status.Open, "not open");

        b.status = Status.Cancelled;
        require(usdc.transfer(b.creator, b.creatorStake), "USDC transfer failed");

        emit BetCancelled(betId);
    }

    // --- Taker action ---

    function acceptBet(uint256 betId) external {
        Bet storage b = bets[betId];
        require(b.status == Status.Open, "not open");
        require(msg.sender != b.creator, "creator cannot accept own bet");
        require(block.timestamp < b.promptAfter, "execution window already started");

        require(usdc.transferFrom(msg.sender, address(this), b.takerStake), "USDC transferFrom failed");

        uint64 matchedAt = uint64(block.timestamp);
        string memory wrapped = _buildPrompt(b.question, matchedAt, b.promptAfter, b.deadline);
        uint256 promptId = chancery.submitPrompt(IPromptChancery.PromptRequest({
            prompt: wrapped,
            promptAfter: b.promptAfter,
            deadline: b.deadline
        }));

        b.taker = msg.sender;
        b.matchedAt = matchedAt;
        b.promptId = promptId;
        b.status = Status.Matched;

        emit BetAccepted(betId, msg.sender, promptId);
    }

    // --- Resolution (anyone) ---

    function resolve(uint256 betId) external {
        Bet storage b = bets[betId];
        require(b.status == Status.Matched, "not matched");

        (address notary, string memory response, ) = chancery.getFulfillment(b.promptId);

        Status outcome;
        if (notary != address(0)) {
            outcome = _parseVerdict(response);
        } else {
            require(block.timestamp > b.deadline, "oracle has not yet fulfilled and deadline has not passed");
            outcome = Status.Refunded;
        }

        b.status = outcome;
        uint256 pot = uint256(b.creatorStake) + uint256(b.takerStake);

        if (outcome == Status.ResolvedYes) {
            require(usdc.transfer(b.creator, pot), "USDC transfer failed");
        } else if (outcome == Status.ResolvedNo) {
            require(usdc.transfer(b.taker, pot), "USDC transfer failed");
        } else {
            // Refunded — return each side their original stake
            require(usdc.transfer(b.creator, b.creatorStake), "USDC creator refund failed");
            require(usdc.transfer(b.taker, b.takerStake), "USDC taker refund failed");
        }

        emit BetResolved(betId, outcome, response);
    }

    // --- View ---

    function getBet(uint256 betId) external view returns (Bet memory) {
        return bets[betId];
    }

    // --- Internal ---

    function _buildPrompt(
        string memory question,
        uint64 matchedAt,
        uint64 promptAfter,
        uint64 deadline
    ) internal pure returns (string memory) {
        return string.concat(
            WRAPPER_PREFIX,
            "Bet context (Unix epoch seconds, UTC): matched=",
            _toString(matchedAt),
            ", earliestResolution=",
            _toString(promptAfter),
            ", deadline=",
            _toString(deadline),
            ".\n\nQuestion: ",
            question
        );
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    function _parseVerdict(string memory response) internal pure returns (Status) {
        bytes memory r = bytes(response);
        uint256 i;
        while (i < r.length && r[i] != 0x0a && r[i] != 0x20 && r[i] != 0x0d) i++;
        bytes memory firstWord = new bytes(i);
        for (uint256 j; j < i; j++) firstWord[j] = r[j];
        bytes32 h = keccak256(firstWord);
        if (h == keccak256(bytes("YES"))) return Status.ResolvedYes;
        if (h == keccak256(bytes("NO")))  return Status.ResolvedNo;
        return Status.Refunded; // UNDECIDED, or anything malformed
    }
}
