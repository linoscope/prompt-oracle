// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import { BetMarket, IERC20, IPromptChancery } from "../BetMarket.sol";
import { MockERC20, MockPromptChancery } from "./Mocks.sol";

contract BetMarketTest is Test {
    BetMarket bm;
    MockERC20 usdc;
    MockPromptChancery chancery;

    address creator = address(0xC4EA70);
    address taker = address(0x7A4E12);

    uint128 constant CREATOR_STAKE = 10e6; // 10 USDC (6 decimals)
    uint128 constant TAKER_STAKE   = 10e6;
    string constant TITLE = "linoscope X post";
    string constant QUESTION = "Will linoscope post on X with at least 100 likes within May?";

    function setUp() public {
        usdc = new MockERC20();
        chancery = new MockPromptChancery();
        bm = new BetMarket(IERC20(address(usdc)), IPromptChancery(address(chancery)));

        usdc.mint(creator, 1_000e6);
        usdc.mint(taker,   1_000e6);

        vm.prank(creator); usdc.approve(address(bm), type(uint256).max);
        vm.prank(taker);   usdc.approve(address(bm), type(uint256).max);
    }

    // --- helpers ---

    function _create() internal returns (uint256 betId) {
        vm.prank(creator);
        betId = bm.createBet(
            TITLE,
            QUESTION,
            uint64(block.timestamp + 1 hours),
            uint64(block.timestamp + 2 hours),
            CREATOR_STAKE,
            TAKER_STAKE
        );
    }

    function _createAndAccept() internal returns (uint256 betId) {
        betId = _create();
        vm.prank(taker);
        bm.acceptBet(betId);
    }

    // --- createBet ---

    function test_CreateBet_PullsUSDC() public {
        uint256 creatorBalBefore = usdc.balanceOf(creator);
        uint256 contractBalBefore = usdc.balanceOf(address(bm));

        uint256 betId = _create();

        assertEq(usdc.balanceOf(creator), creatorBalBefore - CREATOR_STAKE);
        assertEq(usdc.balanceOf(address(bm)), contractBalBefore + CREATOR_STAKE);
        assertEq(betId, 0);

        BetMarket.Bet memory b = bm.getBet(betId);
        assertEq(b.creator, creator);
        assertEq(b.taker, address(0));
        assertEq(uint256(b.creatorStake), CREATOR_STAKE);
        assertEq(uint256(b.takerStake), TAKER_STAKE);
        assertEq(b.title, TITLE);
        assertEq(b.question, QUESTION);
        assertEq(uint8(b.status), uint8(BetMarket.Status.Open));
    }

    function test_CreateBet_RevertsOnPastDeadline() public {
        vm.prank(creator);
        vm.expectRevert(bytes("deadline must follow promptAfter"));
        bm.createBet(TITLE, QUESTION, uint64(block.timestamp + 2 hours), uint64(block.timestamp + 1 hours), CREATOR_STAKE, TAKER_STAKE);

        vm.prank(creator);
        vm.expectRevert(bytes("promptAfter must be in the future"));
        bm.createBet(TITLE, QUESTION, uint64(block.timestamp - 1), uint64(block.timestamp + 1 hours), CREATOR_STAKE, TAKER_STAKE);

        vm.prank(creator);
        vm.expectRevert(bytes("stakes must be > 0"));
        bm.createBet(TITLE, QUESTION, uint64(block.timestamp + 1 hours), uint64(block.timestamp + 2 hours), 0, TAKER_STAKE);
    }

    // --- acceptBet ---

    function test_AcceptBet_PullsUSDC_SubmitsPrompt() public {
        uint256 betId = _create();
        uint256 takerBalBefore = usdc.balanceOf(taker);

        vm.prank(taker);
        bm.acceptBet(betId);

        assertEq(usdc.balanceOf(taker), takerBalBefore - TAKER_STAKE);
        assertEq(usdc.balanceOf(address(bm)), uint256(CREATOR_STAKE) + uint256(TAKER_STAKE));

        BetMarket.Bet memory b = bm.getBet(betId);
        assertEq(b.taker, taker);
        assertEq(uint8(b.status), uint8(BetMarket.Status.Matched));
        assertGt(b.matchedAt, 0);

        // The prompt sent to the chancery must include both the static
        // instruction block and the per-bet context (matched / earliest-
        // resolution / deadline as Unix-epoch seconds), so the LLM can
        // resolve relative-time questions without the question itself
        // having to bake in absolute UTC dates.
        (string memory storedPrompt, , ) = chancery.prompts(b.promptId);
        string memory expected = string.concat(
            "Answer the following question. Output exactly two parts. ",
            "Line 1: one word, either YES, NO, or UNDECIDED. ",
            "Line 2 onwards: your reasoning.\n\n",
            "Bet context (Unix epoch seconds, UTC): matched=",
            vm.toString(uint256(b.matchedAt)),
            ", earliestResolution=",
            vm.toString(uint256(b.promptAfter)),
            ", deadline=",
            vm.toString(uint256(b.deadline)),
            ".\n\nQuestion: ",
            QUESTION
        );
        assertEq(storedPrompt, expected);
    }

    function test_AcceptBet_RevertsIfCreator() public {
        uint256 betId = _create();
        vm.prank(creator);
        vm.expectRevert(bytes("creator cannot accept own bet"));
        bm.acceptBet(betId);
    }

    function test_AcceptBet_RevertsIfWindowStarted() public {
        uint256 betId = _create();
        skip(2 hours);
        vm.prank(taker);
        vm.expectRevert(bytes("execution window already started"));
        bm.acceptBet(betId);
    }

    // --- cancel ---

    function test_Cancel_RefundsCreator_OnlyIfOpen() public {
        uint256 betId = _create();
        uint256 creatorBalBefore = usdc.balanceOf(creator);

        vm.prank(creator);
        bm.cancel(betId);

        assertEq(usdc.balanceOf(creator), creatorBalBefore + CREATOR_STAKE);
        assertEq(uint8(bm.getBet(betId).status), uint8(BetMarket.Status.Cancelled));

        // Cannot cancel twice
        vm.prank(creator);
        vm.expectRevert(bytes("not open"));
        bm.cancel(betId);
    }

    function test_Cancel_NonCreator_Reverts() public {
        uint256 betId = _create();
        vm.prank(taker);
        vm.expectRevert(bytes("not creator"));
        bm.cancel(betId);
    }

    // --- resolve ---

    function test_Resolve_YES_PaysCreator() public {
        uint256 betId = _createAndAccept();
        uint256 promptId = bm.getBet(betId).promptId;
        chancery.mockFulfill(promptId, "YES\nThe answer is yes because reasons.");

        uint256 creatorBalBefore = usdc.balanceOf(creator);
        uint256 takerBalBefore = usdc.balanceOf(taker);

        bm.resolve(betId);

        assertEq(usdc.balanceOf(creator), creatorBalBefore + CREATOR_STAKE + TAKER_STAKE);
        assertEq(usdc.balanceOf(taker), takerBalBefore);
        assertEq(usdc.balanceOf(address(bm)), 0);
        assertEq(uint8(bm.getBet(betId).status), uint8(BetMarket.Status.ResolvedYes));
    }

    function test_Resolve_NO_PaysTaker() public {
        uint256 betId = _createAndAccept();
        uint256 promptId = bm.getBet(betId).promptId;
        chancery.mockFulfill(promptId, "NO\nThe answer is no.");

        uint256 creatorBalBefore = usdc.balanceOf(creator);
        uint256 takerBalBefore = usdc.balanceOf(taker);

        bm.resolve(betId);

        assertEq(usdc.balanceOf(creator), creatorBalBefore);
        assertEq(usdc.balanceOf(taker), takerBalBefore + CREATOR_STAKE + TAKER_STAKE);
        assertEq(uint8(bm.getBet(betId).status), uint8(BetMarket.Status.ResolvedNo));
    }

    function test_Resolve_UNDECIDED_RefundsBoth() public {
        uint256 betId = _createAndAccept();
        uint256 promptId = bm.getBet(betId).promptId;
        chancery.mockFulfill(promptId, "UNDECIDED\nNot enough information.");

        uint256 creatorBalBefore = usdc.balanceOf(creator);
        uint256 takerBalBefore = usdc.balanceOf(taker);

        bm.resolve(betId);

        assertEq(usdc.balanceOf(creator), creatorBalBefore + CREATOR_STAKE);
        assertEq(usdc.balanceOf(taker), takerBalBefore + TAKER_STAKE);
        assertEq(uint8(bm.getBet(betId).status), uint8(BetMarket.Status.Refunded));
    }

    function test_Resolve_Malformed_RefundsBoth() public {
        // "Yes." (with period) is not exactly "YES" — should refund as malformed.
        uint256 betId = _createAndAccept();
        uint256 promptId = bm.getBet(betId).promptId;
        chancery.mockFulfill(promptId, "Yes.\nWith a period.");

        bm.resolve(betId);

        assertEq(uint8(bm.getBet(betId).status), uint8(BetMarket.Status.Refunded));
    }

    function test_Resolve_DeadlineNoFulfillment_Refunds() public {
        uint256 betId = _createAndAccept();
        skip(3 hours); // past deadline (2 hours)

        uint256 creatorBalBefore = usdc.balanceOf(creator);
        uint256 takerBalBefore = usdc.balanceOf(taker);

        bm.resolve(betId);

        assertEq(usdc.balanceOf(creator), creatorBalBefore + CREATOR_STAKE);
        assertEq(usdc.balanceOf(taker), takerBalBefore + TAKER_STAKE);
        assertEq(uint8(bm.getBet(betId).status), uint8(BetMarket.Status.Refunded));
    }

    function test_Resolve_RevertsBeforeFulfillmentAndBeforeDeadline() public {
        uint256 betId = _createAndAccept();
        vm.expectRevert(bytes("oracle has not yet fulfilled and deadline has not passed"));
        bm.resolve(betId);
    }

    function test_DoubleResolve_Reverts() public {
        uint256 betId = _createAndAccept();
        uint256 promptId = bm.getBet(betId).promptId;
        chancery.mockFulfill(promptId, "YES\nbecause");
        bm.resolve(betId);

        vm.expectRevert(bytes("not matched"));
        bm.resolve(betId);
    }

    // --- invariant ---

    function test_Invariant_ContractBalance_AfterEachStateTransition() public {
        // Open → Matched → Resolved chain, balance must always equal sum of active stakes.
        assertEq(usdc.balanceOf(address(bm)), 0);

        uint256 betId = _create();
        assertEq(usdc.balanceOf(address(bm)), CREATOR_STAKE);

        vm.prank(taker); bm.acceptBet(betId);
        assertEq(usdc.balanceOf(address(bm)), uint256(CREATOR_STAKE) + uint256(TAKER_STAKE));

        chancery.mockFulfill(bm.getBet(betId).promptId, "YES\n.");
        bm.resolve(betId);
        assertEq(usdc.balanceOf(address(bm)), 0);
    }
}
