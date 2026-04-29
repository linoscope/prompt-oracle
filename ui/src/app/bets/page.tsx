"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ConnectKitButton } from "connectkit"
import {
  useAccount,
  useChainId,
  useReadContract,
  useReadContracts,
  useSwitchChain,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi"
import { base } from "wagmi/chains"
import { formatUnits, parseUnits } from "viem"
import {
  BETMARKET_ADDRESS,
  BETMARKET_ABI,
  USDC_ADDRESS,
  USDC_DECIMALS,
  ERC20_ABI,
  STATUS_LABELS,
  buildPromptPreview,
} from "../betmarket-contract"

function localToUnix(value: string): bigint {
  return BigInt(Math.floor(new Date(value).getTime() / 1000))
}

function LocalTz() {
  const [tz, setTz] = useState("...")
  useEffect(() => {
    setTz(Intl.DateTimeFormat().resolvedOptions().timeZone)
  }, [])
  return <span className="font-mono">{tz}</span>
}

// Format a Date as the YYYY-MM-DDTHH:MM string a <input type="datetime-local">
// expects, in the *local* timezone. (toISOString is UTC, which would skew the
// default for any user not on UTC.)
function defaultLocal(offsetMinutes: number): string {
  const d = new Date(Date.now() + offsetMinutes * 60_000)
  d.setSeconds(0, 0)
  const tzOffsetMs = d.getTimezoneOffset() * 60_000
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 16)
}

function CreateBet() {
  const router = useRouter()
  const { address } = useAccount()
  const [title, setTitle] = useState("")
  const [question, setQuestion] = useState("")
  const [promptAfterLocal, setPromptAfterLocal] = useState(defaultLocal(60))
  const [deadlineLocal, setDeadlineLocal] = useState(defaultLocal(180))
  const [creatorStake, setCreatorStake] = useState("1")
  const [takerStake, setTakerStake] = useState("1")

  const creatorStakeWei = parseUnits(creatorStake || "0", USDC_DECIMALS)

  const { data: allowance } = useReadContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, BETMARKET_ADDRESS] : undefined,
    query: { enabled: !!address, refetchInterval: 4000 },
  })
  const needsApproval = (allowance ?? 0n) < creatorStakeWei

  const { writeContract: writeApprove, data: approveHash, isPending: approvePending } =
    useWriteContract()
  const { isLoading: approveConfirming, isSuccess: approveSuccess } = useWaitForTransactionReceipt({
    hash: approveHash,
  })

  const {
    writeContract: writeCreate,
    data: createHash,
    isPending: createPending,
  } = useWriteContract()
  const {
    isLoading: createConfirming,
    isSuccess: createSuccess,
    data: createReceipt,
  } = useWaitForTransactionReceipt({ hash: createHash })

  // Auto-navigate to /bets/<id> as soon as the BetCreated event lands. betId is
  // the first indexed topic on any BetMarket log emitted by this tx.
  useEffect(() => {
    if (!createSuccess || !createReceipt) return
    const log = createReceipt.logs.find(
      (l) =>
        l.address.toLowerCase() === BETMARKET_ADDRESS.toLowerCase() && l.topics.length >= 2
    )
    if (log?.topics[1]) router.push(`/bets/${BigInt(log.topics[1]).toString()}`)
  }, [createSuccess, createReceipt, router])

  const submit = () => {
    if (!title.trim() || !question.trim()) return
    writeCreate({
      address: BETMARKET_ADDRESS,
      abi: BETMARKET_ABI,
      functionName: "createBet",
      chainId: base.id,
      args: [
        title,
        question,
        localToUnix(promptAfterLocal),
        localToUnix(deadlineLocal),
        parseUnits(creatorStake, USDC_DECIMALS),
        parseUnits(takerStake, USDC_DECIMALS),
      ],
    })
  }

  const approve = () => {
    writeApprove({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "approve",
      chainId: base.id,
      args: [BETMARKET_ADDRESS, creatorStakeWei],
    })
  }

  return (
    <div className="bg-gray-900 rounded-lg p-6 border border-gray-800">
      <h2 className="text-lg font-semibold mb-4">Create Bet</h2>
      <input
        className="w-full bg-gray-800 border border-gray-700 rounded p-3 text-gray-100 mb-3"
        type="text"
        maxLength={80}
        placeholder="Title — e.g. linoscope X post within May"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        className="w-full bg-gray-800 border border-gray-700 rounded p-3 text-gray-100 mb-3 resize-none"
        rows={3}
        placeholder="Full question — e.g. Will linoscope post on X with at least 100 likes within May?"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
      />

      <details className="mb-3 text-xs text-gray-500 bg-gray-800 rounded p-3">
        <summary className="cursor-pointer text-gray-400">What gets sent to the oracle</summary>
        <pre className="mt-2 whitespace-pre-wrap text-gray-300">
          {buildPromptPreview(
            question || "<your question>",
            Number(localToUnix(promptAfterLocal || new Date().toISOString().slice(0, 16))),
            Number(localToUnix(deadlineLocal || new Date().toISOString().slice(0, 16))),
          )}
        </pre>
      </details>

      <p className="text-xs text-gray-500 mb-2">
        Times shown in your local timezone (<LocalTz />).
      </p>
      <div className="grid grid-cols-2 gap-4 mb-3">
        <div>
          <label htmlFor="bm-prompt-after" className="text-sm text-gray-400 block mb-1">Resolve after</label>
          <input
            id="bm-prompt-after"
            type="datetime-local"
            className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-gray-100 text-sm"
            value={promptAfterLocal}
            onChange={(e) => setPromptAfterLocal(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="bm-deadline" className="text-sm text-gray-400 block mb-1">Deadline</label>
          <input
            id="bm-deadline"
            type="datetime-local"
            className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-gray-100 text-sm"
            value={deadlineLocal}
            onChange={(e) => setDeadlineLocal(e.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label htmlFor="bm-creator-stake" className="text-sm text-gray-400 block mb-1">Your stake (USDC)</label>
          <input
            id="bm-creator-stake"
            type="number"
            min="0"
            step="0.01"
            className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-gray-100"
            value={creatorStake}
            onChange={(e) => setCreatorStake(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="bm-taker-stake" className="text-sm text-gray-400 block mb-1">Taker stake (USDC)</label>
          <input
            id="bm-taker-stake"
            type="number"
            min="0"
            step="0.01"
            className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-gray-100"
            value={takerStake}
            onChange={(e) => setTakerStake(e.target.value)}
          />
        </div>
      </div>

      {needsApproval ? (
        <button
          onClick={approve}
          disabled={approvePending || approveConfirming}
          className="w-full bg-yellow-600 hover:bg-yellow-700 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2 px-4 rounded transition"
        >
          {approvePending
            ? "Confirm in wallet..."
            : approveConfirming
            ? "Approving USDC..."
            : approveSuccess
            ? "Re-checking allowance..."
            : `Approve ${creatorStake} USDC`}
        </button>
      ) : (
        <button
          onClick={submit}
          disabled={createPending || createConfirming || !title.trim() || !question.trim()}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2 px-4 rounded transition"
        >
          {createPending ? "Confirm in wallet..." : createConfirming ? "Creating bet..." : "Create Bet"}
        </button>
      )}
    </div>
  )
}

const STATUS_COLORS: Record<number, string> = {
  0: "text-yellow-400",   // Open
  1: "text-blue-400",     // Matched
  2: "text-green-400",    // ResolvedYes
  3: "text-green-400",    // ResolvedNo
  4: "text-orange-400",   // Refunded
  5: "text-gray-500",     // Cancelled
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function BetList() {
  const { address } = useAccount()
  const { data: nextId } = useReadContract({
    address: BETMARKET_ADDRESS,
    abi: BETMARKET_ABI,
    functionName: "nextBetId",
    query: { refetchInterval: 5000 },
  })

  const count = Number(nextId ?? 0n)
  // Read all bets in one multicall.
  const { data: bets } = useReadContracts({
    contracts: Array.from({ length: count }, (_, i) => ({
      address: BETMARKET_ADDRESS,
      abi: BETMARKET_ABI,
      functionName: "getBet" as const,
      args: [BigInt(i)] as const,
    })),
    query: { enabled: count > 0, refetchInterval: 5000 },
  })

  if (count === 0) {
    return (
      <div className="mt-8">
        <h2 className="text-lg font-semibold mb-3">Bets ({count})</h2>
        <p className="text-gray-500 text-sm">No bets yet. Create one above.</p>
      </div>
    )
  }

  // Newest first.
  const ids = Array.from({ length: count }, (_, i) => count - 1 - i)

  return (
    <div className="mt-8">
      <h2 className="text-lg font-semibold mb-3">Bets ({count})</h2>
      <div className="space-y-3">
        {ids.map((id) => {
          const result = bets?.[id]
          if (!result || result.status !== "success") {
            return (
              <div key={id} className="bg-gray-900 rounded-lg p-4 border border-gray-800 text-sm text-gray-500">
                Loading bet #{id}…
              </div>
            )
          }
          const b = result.result
          const status = Number(b.status)
          const yours =
            address &&
            (address.toLowerCase() === b.creator.toLowerCase() ||
              address.toLowerCase() === b.taker.toLowerCase())
          return (
            <Link
              href={`/bets/${id}`}
              key={id}
              className="block bg-gray-900 hover:bg-gray-850 rounded-lg p-4 border border-gray-800 transition"
            >
              <div className="flex justify-between items-start mb-2">
                <span className="text-xs text-gray-500 font-mono">
                  #{id}
                  {yours && <span className="ml-2 text-blue-400">(yours)</span>}
                </span>
                <span className={`text-xs font-semibold ${STATUS_COLORS[status]}`}>
                  {STATUS_LABELS[status]}
                </span>
              </div>
              <p className="text-gray-100 font-medium mb-1">{b.title || "(untitled)"}</p>
              <p className="text-gray-500 text-xs mb-2 line-clamp-2">{b.question}</p>
              <div className="text-xs text-gray-500 flex gap-4">
                <span>{formatUnits(b.creatorStake, USDC_DECIMALS)} : {formatUnits(b.takerStake, USDC_DECIMALS)} USDC</span>
                <span>creator {shortAddr(b.creator)}</span>
                {b.taker !== "0x0000000000000000000000000000000000000000" && (
                  <span>taker {shortAddr(b.taker)}</span>
                )}
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}

function NetworkGuard({ children }: { children: React.ReactNode }) {
  const chainId = useChainId()
  const { switchChain, isPending } = useSwitchChain()

  if (chainId !== base.id) {
    return (
      <div className="bg-orange-950/40 border border-orange-700 rounded-lg p-4">
        <div className="text-orange-300 font-semibold mb-2">Wrong network</div>
        <p className="text-sm text-gray-300 mb-3">
          BetMarket lives on Base. Your wallet is on chain id {chainId}.
        </p>
        <button
          onClick={() => switchChain({ chainId: base.id })}
          disabled={isPending}
          className="bg-orange-600 hover:bg-orange-700 disabled:bg-gray-700 text-white px-4 py-2 rounded text-sm"
        >
          {isPending ? "Switching..." : "Switch to Base"}
        </button>
      </div>
    )
  }
  return <>{children}</>
}

export default function Bets() {
  const { isConnected } = useAccount()

  return (
    <main className="max-w-2xl mx-auto px-4 py-8 w-full">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-2xl font-bold">BetMarket</h1>
          <p className="text-sm text-gray-500">
            1v1 prediction bets resolved by{" "}
            <Link href="/" className="text-blue-400 hover:underline">
              PromptChancery
            </Link>
          </p>
        </div>
        <ConnectKitButton />
      </div>

      {isConnected ? (
        <NetworkGuard>
          <CreateBet />
        </NetworkGuard>
      ) : (
        <p className="text-gray-500">Connect a wallet to create a bet.</p>
      )}

      <BetList />
    </main>
  )
}
