/**
 * Notary Relay — connects PromptChancery contract to the TEE prompt oracle.
 *
 * Listens for PromptRequested events, commits, waits for promptAfter,
 * calls TEE /prompt endpoint, and submits proof on-chain.
 *
 * Usage:
 *   node notary-relay.mjs
 *
 * Environment (read from .env.relay if present, else process env):
 *   PRIVATE_KEY         — wallet private key (pays gas)
 *   RPC_URL             — Base HTTP RPC (default: https://mainnet.base.org)
 *   WS_URL              — Base WebSocket RPC (optional, enables real-time events)
 *   CONTRACT_ADDRESS    — deployed PromptChancery address
 *   TEE_URL             — TEE oracle endpoint
 */

import { config as loadEnv } from "dotenv"
loadEnv({ path: ".env.relay" })

import { createPublicClient, createWalletClient, http, webSocket, parseAbi, parseGwei, keccak256, encodePacked, toHex, hexToBytes, recoverPublicKey } from "viem"
import { base } from "viem/chains"
import { privateKeyToAccount } from "viem/accounts"

const PRIVATE_KEY = process.env.PRIVATE_KEY
const RPC_URL = process.env.RPC_URL || "https://mainnet.base.org"
const WS_URL = process.env.WS_URL || ""
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS
const TEE_URL = process.env.TEE_URL

if (!PRIVATE_KEY || !CONTRACT_ADDRESS || !TEE_URL) {
  console.error("Required env vars: PRIVATE_KEY, CONTRACT_ADDRESS, TEE_URL")
  process.exit(1)
}

const account = privateKeyToAccount(PRIVATE_KEY)
const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) })
const walletClient = createWalletClient({ account, chain: base, transport: http(RPC_URL) })

// WebSocket client for real-time events (optional)
const wsClient = WS_URL
  ? createPublicClient({ chain: base, transport: webSocket(WS_URL) })
  : null

const abi = parseAbi([
  "event PromptRequested(uint256 indexed promptId, address requester, string prompt, uint256 promptAfter, uint256 deadline)",
  "event PromptFulfilled(uint256 indexed promptId, address notary, string response)",
  "function commitToPrompt(uint256 promptId)",
  "function submitProof(uint256 promptId, string response, uint256 timestamp, bytes messageSignature, bytes appSignature, bytes kmsSignature, bytes derivedCompressedPubkey, bytes appCompressedPubkey)",
  "function nextPromptId() view returns (uint256)",
  "function getCommitment(uint256 promptId) view returns (address notary)",
  "function getPrompt(uint256 promptId) view returns (address requester, string prompt, uint256 createdAt, uint256 promptAfter, uint256 deadline, uint8 status)",
])

// Track which prompts we've already handled to avoid duplicates
const handledPrompts = new Set()

async function recoverAppPubkey(derivedPubkeyHex, appSignatureHex) {
  const derivedPubkeyClean = derivedPubkeyHex.replace("0x", "")
  const message = `ethereum:${derivedPubkeyClean}`
  const messageHash = keccak256(encodePacked(["string"], [message]))

  const uncompressedPubkey = await recoverPublicKey({ hash: messageHash, signature: appSignatureHex })

  const pubBytes = hexToBytes(uncompressedPubkey)
  const x = pubBytes.slice(1, 33)
  const yLastByte = pubBytes[64]
  const prefix = (yLastByte % 2 === 0) ? 0x02 : 0x03
  const compressed = new Uint8Array(33)
  compressed[0] = prefix
  compressed.set(x, 1)
  return toHex(compressed)
}

// Base's sequencer skips txs tipping below what recent blocks include (~0.007
// gwei), while eth_maxPriorityFeePerGas can suggest 0.001. Such txs get a hash
// back but never mine, and then block the nonce. Tip at the recent median,
// floored, with headroom over the base fee.
const MIN_TIP = parseGwei("0.01")

async function feeOverrides() {
  const fh = await publicClient.getFeeHistory({ blockCount: 10, rewardPercentiles: [50] })
  const tips = fh.reward.map((r) => r[0]).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const median = tips[Math.floor(tips.length / 2)] ?? 0n
  const maxPriorityFeePerGas = median > MIN_TIP ? median : MIN_TIP
  const baseFee = fh.baseFeePerGas[fh.baseFeePerGas.length - 1]
  return { maxPriorityFeePerGas, maxFeePerGas: baseFee * 2n + maxPriorityFeePerGas }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function isCommittedByUs(promptId) {
  const notary = await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi,
    functionName: "getCommitment",
    args: [promptId],
  })
  return notary.toLowerCase() === account.address.toLowerCase()
}

async function handlePrompt(promptId, prompt, promptAfter, deadline, alreadyCommitted = false) {
  const id = Number(promptId)
  if (handledPrompts.has(id)) return
  handledPrompts.add(id)

  console.log(`\n--- Prompt #${id} ---`)
  console.log(`  Prompt: "${prompt}"`)
  console.log(`  Window: ${new Date(Number(promptAfter) * 1000).toISOString()} → ${new Date(Number(deadline) * 1000).toISOString()}`)

  // Step 1: Commit (skipped when resuming a prompt we already committed to)
  if (alreadyCommitted) {
    console.log(`  Already committed by us, resuming`)
  } else {
    console.log(`  Committing...`)
    try {
      const commitHash = await walletClient.writeContract({
        address: CONTRACT_ADDRESS,
        abi,
        functionName: "commitToPrompt",
        args: [promptId],
        ...(await feeOverrides()),
      })
      console.log(`  Committed: ${commitHash}`)
      await publicClient.waitForTransactionReceipt({ hash: commitHash })
    } catch (e) {
      // An RPC timeout can hide a commit that actually landed; check the chain
      // before giving up so the prompt isn't stranded in Committed.
      console.error(`  Commit call errored: ${e.shortMessage || e.message}`)
      await sleep(5000)
      if (!(await isCommittedByUs(promptId).catch(() => false))) {
        console.error(`  Not committed on chain, giving up`)
        handledPrompts.delete(id)
        return
      }
      console.log(`  Commit landed on chain anyway, continuing`)
    }
  }

  // Step 2: Wait for promptAfter
  const now = Math.floor(Date.now() / 1000)
  const waitSeconds = Number(promptAfter) - now
  if (waitSeconds > 0) {
    console.log(`  Waiting ${waitSeconds}s until promptAfter...`)
    await sleep(waitSeconds * 1000 + 2000)
  }

  // Step 3: Call TEE
  console.log(`  Calling TEE: POST ${TEE_URL}/prompt`)
  let teeResponse
  try {
    const res = await fetch(`${TEE_URL}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    })
    teeResponse = await res.json()
    if (teeResponse.error) throw new Error(teeResponse.error)
    console.log(`  Response: "${teeResponse.statement.response.slice(0, 80)}${teeResponse.statement.response.length > 80 ? '...' : ''}"`)
  } catch (e) {
    console.error(`  TEE call failed: ${e.message}`)
    return
  }

  // Step 4: Recover app pubkey
  const appPubkey = await recoverAppPubkey(
    teeResponse.signatureChain.derivedPubkey,
    teeResponse.signatureChain.appSignature
  )
  console.log(`  App pubkey: ${appPubkey.slice(0, 20)}...`)

  // Step 5: Submit proof
  console.log(`  Submitting proof...`)
  try {
    const submitHash = await walletClient.writeContract({
      address: CONTRACT_ADDRESS,
      abi,
      functionName: "submitProof",
      args: [
        promptId,
        teeResponse.statement.response,
        BigInt(teeResponse.statement.timestamp),
        teeResponse.signature,
        teeResponse.signatureChain.appSignature,
        teeResponse.signatureChain.kmsSignature,
        teeResponse.signatureChain.derivedPubkey,
        appPubkey,
      ],
      ...(await feeOverrides()),
    })
    console.log(`  Proof submitted: ${submitHash}`)
    const receipt = await publicClient.waitForTransactionReceipt({ hash: submitHash })
    console.log(`  Status: ${receipt.status === "success" ? "SUCCESS" : "FAILED"}`)
  } catch (e) {
    console.error(`  Failed to submit proof: ${e.message}`)
  }
}

let lastCheckedId = 0

async function pollForNewPrompts() {
  const nextId = Number(await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi,
    functionName: "nextPromptId",
  }))

  if (nextId <= lastCheckedId) return

  for (let i = lastCheckedId; i < nextId; i++) {
    const [requester, prompt, createdAt, promptAfter, deadline, status] = await publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi,
      functionName: "getPrompt",
      args: [BigInt(i)],
    })

    if (BigInt(Math.floor(Date.now() / 1000)) > deadline) continue

    // Status 0 = Open; status 1 = Committed, which we resume if the commitment is ours
    if (Number(status) === 0) {
      console.log(`Poll: Found open prompt #${i}`)
      handlePrompt(BigInt(i), prompt, promptAfter, deadline)
    } else if (Number(status) === 1 && !handledPrompts.has(i) && await isCommittedByUs(BigInt(i))) {
      console.log(`Poll: Found prompt #${i} committed by us but unfulfilled`)
      handlePrompt(BigInt(i), prompt, promptAfter, deadline, true)
    }
  }

  lastCheckedId = nextId
}

async function main() {
  console.log("Notary Relay")
  console.log("============")
  console.log(`  Contract: ${CONTRACT_ADDRESS}`)
  console.log(`  TEE:      ${TEE_URL}`)
  console.log(`  Notary:   ${account.address}`)
  console.log(`  WebSocket: ${WS_URL ? "enabled" : "disabled (set WS_URL for real-time events)"}`)
  console.log()

  // WebSocket: real-time event streaming (if available)
  if (wsClient) {
    console.log("  Subscribing to PromptRequested events via WebSocket...")
    wsClient.watchContractEvent({
      address: CONTRACT_ADDRESS,
      abi,
      eventName: "PromptRequested",
      onLogs: (logs) => {
        for (const log of logs) {
          const { promptId, requester, prompt, promptAfter, deadline } = log.args
          console.log(`WS Event: PromptRequested #${promptId} from ${requester}`)
          handlePrompt(promptId, prompt, promptAfter, deadline)
        }
      },
    })
  }

  // Poll: catch up on startup + periodic fallback every 60s
  console.log("  Scanning for open prompts...\n")
  while (true) {
    try {
      await pollForNewPrompts()
    } catch (e) {
      console.error(`Poll error: ${e.message}`)
    }
    await sleep(60000)
  }
}

main().catch(console.error)
