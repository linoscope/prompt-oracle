export const BETMARKET_ADDRESS = "0x48F207576Ce3915d94a8eAe6BF0d19eE89e9E45d" as const

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

// Mirrors WRAPPER_PREFIX in BetMarket.sol — display in the create form so users
// know exactly what gets sent to the oracle.
export const WRAPPER_PREFIX =
  "Answer the following question. Output exactly two parts. " +
  "Line 1: one word, either YES, NO, or UNDECIDED. " +
  "Line 2 onwards: your reasoning.\n\nQuestion: "
