# BetMarket Design

A 1-vs-1 prediction market that uses [PromptChancery](./DESIGN.md) as its resolution oracle. Two parties lock USDC against a yes/no question; a TEE-attested LLM answers it inside the prompt's execution window; the contract reads the answer and pays out the winner.

## Why this shape

The hard part of prediction markets is the oracle. PromptChancery already gives us a TEE-attested string answer to any question, with cryptographic guarantees about which code produced it. BetMarket adds escrow + payout on top — nothing else. The oracle, the TEE, and the notary stack are reused unchanged.

## Example use cases

The notary's TEE has web search and X search, so questions need to be answerable from public evidence. A few example patterns:

**Public metrics**

- "Will linoscope's post `<URL>` reach ≥100 likes by May 31?"
- "Will linoscope hit 5k X followers by EOY?"
- "Will my repo `github.com/linoscope/wannabet` hit 500 stars by Q3?"
- "Will linoscope merge ≥10 PRs into [repo] in the next 30 days?"
- "Will linoscope publish ≥4 posts on linoscope.xyz in May?"
- "Will linoscope appear on the speaker list at `<conference URL>` by [date]?"

**External events**

- "Will Anthropic publicly announce Opus 5 by July 1?"
- "Will Vitalik post about ZK on X in the next 30 days?"
- "Will Base TVL exceed $X by end of Q3?"
- "Will [team] win [match] on [date]?"

**Private achievement, public proof**

Things that aren't directly visible on the web (a Strava run, a deadlift PR, an exam score) become bettable when the question requires a public artifact as evidence:

- "Will linoscope post on X by [date] with **a screenshot of** Strava showing ≥200km in May?"
- "Will linoscope post on X with **a video of** himself deadlifting 200kg by his birthday?"
- "Will linoscope post on X with **a photo of** his AWS Solutions Architect cert by Q3?"

A determined cheater could photoshop a fake screenshot and the LLM might accept it on appearance alone. One mitigation is to pair the screenshot with a URL. Even if the agent cannot open the URL (e.g., Strava activities are login-gated), requiring it leaves an audit trail — a fake or non-existent URL is itself proof of bad faith, and a real one stays verifiable manually:

> Will [bettor] post on X by [date] with both **a screenshot** AND **a link to** [public profile/activity] showing [outcome]?

### What does *not* fit

- Anything truly private (DMs, email replies, private repo state).
- Outcomes that depend on subjective judgment beyond what the LLM can reasonably evaluate.
- Outcomes outside the prompt's execution window (the LLM only resolves once, at the time of the call).

## Actors

- **Creator**: opens a bet with a question, an execution window, and stakes for both sides.
- **Taker**: matches the bet by locking the counter-stake.
- **Resolver**: anyone — calls `resolve()` once the oracle has answered (or the deadline has passed).
- **PromptChancery + Notary + TEE**: unchanged from the existing tutorial.

## Flow

```
1. Creator calls createBet(question, promptAfter, deadline, creatorStake, takerStake)
   → contract pulls creatorStake USDC
   → status: Open
   → bet visible at /bet/<id>; creator shares the link

2. Taker calls acceptBet(betId)
   → contract pulls takerStake USDC
   → contract calls chancery.submitPrompt({ prompt: WRAPPER_PREFIX + question, promptAfter, deadline })
   → status: Matched

3. Notary picks up PromptRequested event (existing flow), runs question through TEE,
   submits TEE-attested answer to PromptChancery.

4. Anyone calls resolve(betId)
   → reads chancery.getFulfillment(promptId)
   → parses verdict from the response
   → status: ResolvedYes | ResolvedNo | Refunded
   → pot transferred in the same tx (push pattern)

5. If deadline passes with no fulfillment:
   → resolve() refunds both stakes (status: Refunded)

6. Creator can call cancel(betId) any time before a taker accepts
   → creatorStake refunded (status: Cancelled)
```

## State Machine

```
                  createBet
                     │
                     ▼
                  ┌──────┐
        ┌─cancel──│ Open │──acceptBet──▶┌─────────┐
        │         └──────┘              │ Matched │
        ▼                               └────┬────┘
  ┌───────────┐                              │ resolve()
  │ Cancelled │                              ▼
  └───────────┘             ┌────────────────────────────────┐
                            ▼                ▼               ▼
                     ResolvedYes      ResolvedNo        Refunded
                     creator pot      taker pot         both back
                     (transfer happens inside resolve(), no claim step)
```

All terminal states (Cancelled, ResolvedYes, ResolvedNo, Refunded) settle USDC inside the same transaction that triggers them. There is no separate `claim()` — keeps state minimal and avoids a second tx for users.

## Odds

Stake-ratio: creator stakes A, taker stakes B, winner takes A + B.

| Creator stake | Taker stake | Reading |
|---|---|---|
| 10 USDC | 10 USDC | 50:50 — both think it's a coin flip |
| 70 USDC | 30 USDC | Creator thinks YES is ~70% likely; risks 70 to win 30 |
| 5 USDC | 95 USDC | Creator thinks YES is unlikely; risks little for big upside |

Creator picks the ratio when opening; taker either accepts or doesn't. No matchmaking, no order book.

## Wrapper Template

The `acceptBet()` call constructs the chancery prompt by concatenating a hardcoded prefix with the user's `question`:

```
Answer the following question. Output exactly two parts.
Line 1: one word, either YES, NO, or UNDECIDED.
Line 2 onwards: your reasoning.

Question: <user question>
```

The wrapper is a compile-time constant. Two strings exist on chain after a match:

- `BetMarket.bets[id].question` — the raw user question, for display.
- `PromptChancery.prompts[promptId].prompt` — the wrapped prompt, what the notary actually answers.

The UI shows the wrapper visibly to creators when composing a bet, with the user's question highlighted inside it. This makes it impossible for a malicious UI to silently re-frame the question.

## Verdict Parsing

`resolve()` reads `fulfillment.response` from PromptChancery and looks at the **first whitespace-delimited token** of the response:

```solidity
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
```

Anything other than literal `YES` / `NO` becomes a refund. This is the safety net: a misbehaving notary can force a draw but cannot misresolve toward the wrong side.

## Data Structures

```solidity
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
    string  question;       // raw, for UI display
    uint64  promptAfter;
    uint64  deadline;
    uint64  createdAt;
    uint64  matchedAt;
    uint256 promptId;       // set on accept
    Status  status;
}

uint256 public nextBetId;
mapping(uint256 => Bet) public bets;
```

`uint128` for stakes is far more than enough for USDC (6 decimals); halves the storage slot. Timestamps as `uint64` pack efficiently.

## Interface

```solidity
// Creator
function createBet(
    string  calldata question,
    uint64  promptAfter,
    uint64  deadline,
    uint128 creatorStake,
    uint128 takerStake
) external returns (uint256 betId);

function cancel(uint256 betId) external;

// Taker
function acceptBet(uint256 betId) external;

// Resolution (anyone)
function resolve(uint256 betId) external;

// View
function getBet(uint256 betId) external view returns (Bet memory);
```

## Events

```solidity
event BetCreated(
    uint256 indexed betId,
    address indexed creator,
    string  question,
    uint64  promptAfter,
    uint64  deadline,
    uint128 creatorStake,
    uint128 takerStake
);
event BetAccepted(uint256 indexed betId, address indexed taker, uint256 promptId);
event BetCancelled(uint256 indexed betId);
event BetResolved(uint256 indexed betId, Status status, string response);
```

`BetResolved` carries the full chancery response so indexers can render reasoning without a second read.

## Pre-conditions

| Function | Requires |
|---|---|
| `createBet` | `usdc.allowance(msg.sender, this) >= creatorStake`, `deadline > promptAfter > block.timestamp`, both stakes > 0 |
| `acceptBet` | `usdc.allowance(taker, this) >= takerStake`, `bet.status == Open`, `block.timestamp < bet.promptAfter`, `msg.sender != bet.creator` |
| `cancel` | `msg.sender == bet.creator`, `bet.status == Open` |
| `resolve` | `bet.status == Matched`; either chancery fulfillment exists, or `block.timestamp > bet.deadline` |

## Edge Cases

| Case | Behavior |
|---|---|
| Creator tries to accept own bet | Reverts in `acceptBet` (`msg.sender != bet.creator`) |
| Bet matched, deadline passes, no notary response | `resolve()` refunds both stakes |
| Notary returns `"Yes."` with a period | First-word parse strips on whitespace, so `Yes.` ≠ `YES` → Refunded. Wrapper says "one word" explicitly; if real LLMs reliably add punctuation, expand the parser case-insensitively / strip trailing punctuation |
| Multiple `resolve()` calls | First call transitions to a terminal state; subsequent calls revert on status check |
| Creator cancels concurrently with `acceptBet` | Atomic: whichever lands first wins; the other reverts on `status != Open` |
| Bet sits Open past `promptAfter` | `acceptBet` reverts (window already started, no time for notary). Creator can `cancel` at any time |

## Invariants

- USDC balance of the contract = sum of stakes of all bets currently in `{Open, Matched}`.
- A bet only ever transitions forward; terminal states never re-enter.
- For a Matched bet, `bet.promptId` is a valid PromptChancery id with `prompt = WRAPPER_PREFIX + bet.question`.

## Architecture

```
┌──────┐    USDC escrow     ┌─────────────┐  submitPrompt   ┌─────────────────┐
│  UI  │───────────────────▶│  BetMarket  │────────────────▶│ PromptChancery  │
│      │   reads bets       │  (escrow +  │  reads result   │  (existing,     │
│      │◀───────────────────│   payout)   │◀────────────────│   unchanged)    │
└──────┘                    └─────────────┘                 └─────────────────┘
                                                                     ▲
                                                            TEE-attested fulfill
                                                             from notary-relay
```

BetMarket is parameterized by `IERC20 usdc` and `IPromptChancery chancery` at construction. Both are immutable — swapping either requires a new deployment.

## Share Link

Plain URL, no signing — bet state is fully on-chain:

```
https://<host>/bet/<betId>
```

Anyone with the URL can:
- View the bet (regardless of wallet).
- Connect a wallet and accept (if Open and they aren't the creator).
- Trigger `resolve()` once conditions are met.

## UI Pages

```
/                → "Create a bet" form + list of your own bets
/bet/<id>        → Bet detail (the shareable page)
```

Detail page renders by status:

| Status | Shown | Actions |
|---|---|---|
| Open | question, stakes, both timestamps, share link | Creator: Cancel. Other: Accept (lock X USDC) |
| Matched | + taker, promptId, link to chancery | Before fulfillment + before deadline: "Awaiting oracle". After fulfillment: Resolve & Pay Out (anyone). After deadline: Refund (anyone) |
| ResolvedYes / ResolvedNo | verdict badge, full reasoning expandable, winner address, amount paid | (terminal) |
| Refunded | reason ("UNDECIDED" / "Oracle timed out") + reasoning if any | (terminal) |
| Cancelled | "Cancelled by creator before match" | (terminal) |

## What the Contract Does Not Do

Deliberately deferred:

- **Fees / protocol revenue**. v1 is fee-free.
- **Multi-token**. USDC only in v1.
- **Pool / parimutuel**. 1v1 only; multiple takers is a different contract.
- **Wrapper versioning**. Wrapper is hardcoded; iterating means a new deployment.
- **Bet discovery / public feed**. UI shows your own bets only; needs an indexer for global discovery.
- **Dispute window between resolve and payout**. Resolution is final and atomic with payout.
- **Min stake floor**. Dust spam acceptable in v1.

## Test Plan

### Foundry (unit)

`test/BetMarket.t.sol` against a `MockPromptChancery` (settable `getFulfillment`) and `MockERC20`:

- `test_CreateBet_PullsUSDC`
- `test_CreateBet_RevertsOnPastDeadline`
- `test_AcceptBet_PullsUSDC_SubmitsPrompt`
- `test_AcceptBet_RevertsIfCreator`
- `test_Cancel_RefundsCreator_OnlyIfOpen`
- `test_Resolve_YES_PaysCreator`
- `test_Resolve_NO_PaysTaker`
- `test_Resolve_UNDECIDED_RefundsBoth`
- `test_Resolve_Malformed_RefundsBoth` (e.g., `"Yes."` with a period)
- `test_Resolve_DeadlineNoFulfillment_Refunds`
- `test_Resolve_RevertsBeforeFulfillmentAndBeforeDeadline`
- `test_DoubleResolve_Reverts`
- `test_Invariant_ContractBalance` (sum of active stakes)

### E2E (Playwright + viem burner)

Same pattern as the [PromptChancery UI test](./AGENTS.md#writing-e2e-tests-for-the-ui), against live Base mainnet + live PromptChancery + live notary. Two burners (creator + taker), funded with ETH and USDC on Base.

```
01-create-form-empty       → /
02-create-form-filled      → after typing question + stakes
03-prompt-preview          → wrapper visible with user question highlighted
04-bet-created             → /bet/<id> as creator (Open + share link)
05-bet-as-taker-open       → /bet/<id> as taker (Accept CTA)
06-bet-matched             → after accept (Matched, awaiting oracle)
07-bet-fulfilled-yes       → after notary fulfillment
08-bet-resolved-paid       → after resolve() (creator pot, reasoning shown)
```

Plus parallel specs for NO and UNDECIDED outcomes.

## Build Order

1. `BetMarket.sol` + foundry tests against `MockPromptChancery` and `MockERC20`.
2. Deploy `BetMarket` to Base mainnet against the existing `PromptChancery`.
3. UI: extend `ui/` with `/bets` (create) and `/bets/[id]` (detail) routes.
4. E2E specs with the existing viem burner pattern.
5. Manual mainnet smoke before announcing.

## What This Doc Doesn't Lock In

Open questions left for review:

- **Wrapper exact wording**. Locked in for v1, but worth re-checking against real LLM behavior on a sample of bet questions before deploy.
- **Min notary window**. `acceptBet` enforces `block.timestamp < promptAfter` — meaning matching a bet right before `promptAfter` could leave the notary no time. Considered adding a min-window check (e.g., `promptAfter - block.timestamp > 60s`) but skipped for v1; worst case, the bet refunds.
- **Discovery / indexer**. v1 has no global feed. Add a subgraph if/when usage warrants it.
