export const BETMARKET_ADDRESS = "0x6F6987F02Ae9d5a46c87043fE8c5c69E3dF2498d" as const

// Base USDC — used for approve() before createBet/acceptBet.
export const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const

export const USDC_DECIMALS = 6

// Source-of-truth for verdict labels — mirrors BetMarket.Status enum order.
export const STATUS_LABELS = [
  "Open",
  "Matched",
  "ResolvedYes",
  "ResolvedNo",
  "Refunded",
  "Cancelled",
] as const
export type StatusIndex = 0 | 1 | 2 | 3 | 4 | 5

export const ERC20_ABI = [
  {
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const

export const BETMARKET_ABI = [
  // --- writes ---
  {
    inputs: [
      { name: "title", type: "string" },
      { name: "question", type: "string" },
      { name: "promptAfter", type: "uint64" },
      { name: "deadline", type: "uint64" },
      { name: "creatorStake", type: "uint128" },
      { name: "takerStake", type: "uint128" },
    ],
    name: "createBet",
    outputs: [{ name: "betId", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "betId", type: "uint256" }],
    name: "acceptBet",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "betId", type: "uint256" }],
    name: "cancel",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "betId", type: "uint256" }],
    name: "resolve",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // --- reads ---
  {
    inputs: [{ name: "betId", type: "uint256" }],
    name: "getBet",
    outputs: [
      {
        components: [
          { name: "creator", type: "address" },
          { name: "taker", type: "address" },
          { name: "creatorStake", type: "uint128" },
          { name: "takerStake", type: "uint128" },
          { name: "title", type: "string" },
          { name: "question", type: "string" },
          { name: "promptAfter", type: "uint64" },
          { name: "deadline", type: "uint64" },
          { name: "createdAt", type: "uint64" },
          { name: "matchedAt", type: "uint64" },
          { name: "promptId", type: "uint256" },
          { name: "status", type: "uint8" },
        ],
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "nextBetId",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  // --- events ---
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "betId", type: "uint256" },
      { indexed: true, name: "creator", type: "address" },
      { indexed: false, name: "title", type: "string" },
      { indexed: false, name: "question", type: "string" },
      { indexed: false, name: "promptAfter", type: "uint64" },
      { indexed: false, name: "deadline", type: "uint64" },
      { indexed: false, name: "creatorStake", type: "uint128" },
      { indexed: false, name: "takerStake", type: "uint128" },
    ],
    name: "BetCreated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "betId", type: "uint256" },
      { indexed: true, name: "taker", type: "address" },
      { indexed: false, name: "promptId", type: "uint256" },
    ],
    name: "BetAccepted",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, name: "betId", type: "uint256" }],
    name: "BetCancelled",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "betId", type: "uint256" },
      { indexed: false, name: "status", type: "uint8" },
      { indexed: false, name: "response", type: "string" },
    ],
    name: "BetResolved",
    type: "event",
  },
] as const

// Mirrors the prompt assembly in BetMarket.acceptBet — used by the create
// form to preview exactly what the oracle will see. The bet-context line
// uses placeholders here because the matched/promptAfter/deadline values
// are only known at acceptBet time on chain; the form fills the latter
// two from the user's form inputs and shows "<matchedAt>" as a sentinel.
export const WRAPPER_PREFIX =
  "Answer the following question. Output exactly two parts. " +
  "Line 1: one word, either YES, NO, or UNDECIDED. " +
  "Line 2 onwards: your reasoning.\n\n"

export function buildPromptPreview(
  question: string,
  promptAfter: number,
  deadline: number,
): string {
  return (
    WRAPPER_PREFIX +
    `Bet context (Unix epoch seconds, UTC): matched=<set when accepted>, ` +
    `earliestResolution=${promptAfter}, deadline=${deadline}.\n\n` +
    `Question: ${question}`
  )
}
