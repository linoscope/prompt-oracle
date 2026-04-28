export const CONTRACT_ADDRESS = "0xE453E01aEF962A836a0B78AbB91a18f01C3d8160" as const

export const CONTRACT_ABI = [
  {
    inputs: [{ name: "promptId", type: "uint256" }],
    name: "getPrompt",
    outputs: [
      { name: "requester", type: "address" },
      { name: "prompt", type: "string" },
      { name: "createdAt", type: "uint256" },
      { name: "promptAfter", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "status", type: "uint8" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "promptId", type: "uint256" }],
    name: "getFulfillment",
    outputs: [
      { name: "notary", type: "address" },
      { name: "response", type: "string" },
      { name: "fulfilledAt", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "promptId", type: "uint256" }],
    name: "getCommitment",
    outputs: [{ name: "notary", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "promptId", type: "uint256" }],
    name: "isExpired",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "nextPromptId",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "prompt", type: "string" },
          { name: "promptAfter", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    name: "submitPrompt",
    outputs: [{ name: "promptId", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "promptId", type: "uint256" }],
    name: "cancelPrompt",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "promptId", type: "uint256", indexed: true },
      { name: "requester", type: "address", indexed: false },
      { name: "prompt", type: "string", indexed: false },
      { name: "promptAfter", type: "uint256", indexed: false },
      { name: "deadline", type: "uint256", indexed: false },
    ],
    name: "PromptRequested",
    type: "event",
    anonymous: false,
  },
  {
    inputs: [
      { name: "promptId", type: "uint256", indexed: true },
      { name: "notary", type: "address", indexed: false },
      { name: "response", type: "string", indexed: false },
    ],
    name: "PromptFulfilled",
    type: "event",
    anonymous: false,
  },
] as const
