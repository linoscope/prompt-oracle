"use client"

import { useState, useEffect } from "react"
import { useParams } from "next/navigation"
import Link from "next/link"
import { ConnectKitButton } from "connectkit"
import {
  useAccount,
  useChainId,
  useReadContract,
  useSwitchChain,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi"
import { base } from "wagmi/chains"
import { useQueryClient } from "@tanstack/react-query"
import { formatUnits } from "viem"
import {
  BETMARKET_ADDRESS,
  BETMARKET_ABI,
  USDC_ADDRESS,
  USDC_DECIMALS,
  ERC20_ABI,
  STATUS_LABELS,
} from "../../betmarket-contract"
import { CONTRACT_ADDRESS as CHANCERY_ADDRESS, CONTRACT_ABI as CHANCERY_ABI } from "../../contract"

const STATUS_COLORS: Record<number, string> = {
  0: "text-yellow-400",   // Open
  1: "text-blue-400",     // Matched
  2: "text-green-400",    // ResolvedYes
  3: "text-green-400",    // ResolvedNo
  4: "text-orange-400",   // Refunded
  5: "text-gray-500",     // Cancelled
}

function fmtUSDC(v: bigint): string {
  return `${formatUnits(v, USDC_DECIMALS)} USDC`
}

function fmtTime(unix: bigint): string {
  return new Date(Number(unix) * 1000).toLocaleString()
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function LocalTz() {
  const [tz, setTz] = useState("...")
  useEffect(() => {
    setTz(Intl.DateTimeFormat().resolvedOptions().timeZone)
  }, [])
  return <span className="font-mono">{tz}</span>
}

function NetworkGuardInline() {
  const chainId = useChainId()
  const { switchChain, isPending } = useSwitchChain()
  if (chainId === base.id) return null
  return (
    <div className="bg-orange-950/40 border border-orange-700 rounded p-3 my-3 flex items-center justify-between gap-3">
      <span className="text-sm text-orange-300">
        Wallet on chain {chainId}; BetMarket lives on Base.
      </span>
      <button
        onClick={() => switchChain({ chainId: base.id })}
        disabled={isPending}
        className="bg-orange-600 hover:bg-orange-700 disabled:bg-gray-700 text-white px-3 py-1 rounded text-sm whitespace-nowrap"
      >
        {isPending ? "Switching..." : "Switch to Base"}
      </button>
    </div>
  )
}

function ResolutionPanel({
  betId,
  promptId,
  deadline,
}: {
  betId: bigint
  promptId: bigint
  deadline: bigint
}) {
  const queryClient = useQueryClient()
  const { data: fulfillment } = useReadContract({
    address: CHANCERY_ADDRESS,
    abi: CHANCERY_ABI,
    functionName: "getFulfillment",
    args: [promptId],
    query: { refetchInterval: 5000 },
  })

  const fulfilled = !!fulfillment && fulfillment[0] !== "0x0000000000000000000000000000000000000000"
  const expired = BigInt(Math.floor(Date.now() / 1000)) > deadline

  const { writeContract, data: hash, isPending } = useWriteContract()
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash })
  useEffect(() => {
    if (isSuccess) queryClient.invalidateQueries()
  }, [isSuccess, queryClient])

  const triggerResolve = () => {
    writeContract({
      address: BETMARKET_ADDRESS,
      abi: BETMARKET_ABI,
      functionName: "resolve",
      chainId: base.id,
      args: [betId],
    })
  }

  return (
    <div className="bg-gray-800 rounded p-4 mt-4 border border-gray-700">
      <div className="text-sm text-gray-400 mb-2">
        Oracle prompt: <span className="font-mono">#{promptId.toString()}</span>
      </div>
      {fulfilled ? (
        <>
          <div className="text-xs text-green-400 font-semibold mb-2">Oracle responded</div>
          <pre className="bg-gray-900 rounded p-3 text-sm text-gray-200 whitespace-pre-wrap">
            {fulfillment[1]}
          </pre>
          <button
            onClick={triggerResolve}
            disabled={isPending || confirming}
            className="mt-3 w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white font-medium py-2 rounded"
          >
            {isPending ? "Confirm in wallet..." : confirming ? "Resolving..." : "Resolve & Pay Out"}
          </button>
        </>
      ) : expired ? (
        <>
          <div className="text-orange-400 mb-2">Oracle did not fulfill before the deadline.</div>
          <button
            onClick={triggerResolve}
            disabled={isPending || confirming}
            className="w-full bg-orange-600 hover:bg-orange-700 disabled:bg-gray-700 text-white font-medium py-2 rounded"
          >
            {isPending ? "Confirm in wallet..." : confirming ? "Refunding..." : "Refund Both"}
          </button>
        </>
      ) : (
        <div className="text-gray-400 text-sm">
          Awaiting the TEE oracle. Window: {fmtTime(deadline)}.
        </div>
      )}
    </div>
  )
}

function AcceptPanel({ betId, takerStake }: { betId: bigint; takerStake: bigint }) {
  const queryClient = useQueryClient()
  const { address } = useAccount()

  const { data: allowance } = useReadContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, BETMARKET_ADDRESS] : undefined,
    query: { enabled: !!address, refetchInterval: 4000 },
  })
  const needsApproval = (allowance ?? 0n) < takerStake

  const { writeContract, data: hash, isPending } = useWriteContract()
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash })
  useEffect(() => {
    if (isSuccess) queryClient.invalidateQueries()
  }, [isSuccess, queryClient])

  const approve = () =>
    writeContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "approve",
      chainId: base.id,
      args: [BETMARKET_ADDRESS, takerStake],
    })
  const accept = () =>
    writeContract({
      address: BETMARKET_ADDRESS,
      abi: BETMARKET_ABI,
      functionName: "acceptBet",
      chainId: base.id,
      args: [betId],
    })

  return needsApproval ? (
    <button
      onClick={approve}
      disabled={isPending || confirming}
      className="w-full bg-yellow-600 hover:bg-yellow-700 disabled:bg-gray-700 text-white font-medium py-3 rounded"
    >
      {isPending
        ? "Confirm in wallet..."
        : confirming
        ? "Approving USDC..."
        : `Approve ${formatUnits(takerStake, USDC_DECIMALS)} USDC`}
    </button>
  ) : (
    <button
      onClick={accept}
      disabled={isPending || confirming}
      className="w-full bg-green-600 hover:bg-green-700 disabled:bg-gray-700 text-white font-medium py-3 rounded"
    >
      {isPending
        ? "Confirm in wallet..."
        : confirming
        ? "Accepting..."
        : `Accept bet (lock ${fmtUSDC(takerStake)})`}
    </button>
  )
}

export default function BetDetail() {
  const params = useParams<{ id: string }>()
  const betId = BigInt(params.id)
  const { address } = useAccount()
  const queryClient = useQueryClient()

  const { data: bet, refetch } = useReadContract({
    address: BETMARKET_ADDRESS,
    abi: BETMARKET_ABI,
    functionName: "getBet",
    args: [betId],
    query: { refetchInterval: 5000 },
  })

  const { writeContract: cancelWrite, data: cancelHash, isPending: cancelPending } =
    useWriteContract()
  const { isLoading: cancelConfirming, isSuccess: cancelSuccess } = useWaitForTransactionReceipt({
    hash: cancelHash,
  })
  useEffect(() => {
    if (cancelSuccess) {
      queryClient.invalidateQueries()
      refetch()
    }
  }, [cancelSuccess, queryClient, refetch])

  const [shareUrl, setShareUrl] = useState("")
  useEffect(() => {
    if (typeof window !== "undefined") setShareUrl(window.location.href)
  }, [])

  if (!bet) {
    return (
      <main className="max-w-2xl mx-auto px-4 py-8 w-full">
        <p className="text-gray-500">Loading bet #{params.id}…</p>
      </main>
    )
  }

  // Non-existent bet: getBet returns the default struct with creator==0x0.
  if (bet.creator === "0x0000000000000000000000000000000000000000") {
    return (
      <main className="max-w-2xl mx-auto px-4 py-8 w-full">
        <Link href="/bets" className="text-sm text-gray-500 hover:text-gray-300">
          ← BetMarket
        </Link>
        <h1 className="text-2xl font-bold mt-2 mb-4">Bet #{params.id}</h1>
        <p className="text-gray-500">No bet at this id.</p>
      </main>
    )
  }

  const status = Number(bet.status)
  const isCreator = address?.toLowerCase() === bet.creator.toLowerCase()
  const isTaker = address?.toLowerCase() === bet.taker.toLowerCase()

  return (
    <main className="max-w-2xl mx-auto px-4 py-8 w-full">
      <div className="flex justify-between items-center mb-8">
        <div>
          <Link href="/bets" className="text-sm text-gray-500 hover:text-gray-300">
            ← BetMarket
          </Link>
          <h1 className="text-2xl font-bold">Bet #{params.id}</h1>
        </div>
        <ConnectKitButton />
      </div>

      <div className="bg-gray-900 rounded-lg p-6 border border-gray-800">
        <div className="flex justify-between items-start mb-4">
          <span className={`text-sm font-semibold ${STATUS_COLORS[status]}`}>
            {STATUS_LABELS[status]}
          </span>
        </div>

        <h2 className="text-gray-100 text-xl font-semibold mb-2">{bet.title || "(untitled)"}</h2>
        <p className="text-gray-400 text-sm whitespace-pre-wrap mb-4">{bet.question}</p>

        <div className="grid grid-cols-2 gap-3 text-sm text-gray-400 mb-4">
          <div>
            <div className="text-xs text-gray-500">Creator stakes</div>
            <div className="text-gray-200">{fmtUSDC(bet.creatorStake)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">Taker stakes</div>
            <div className="text-gray-200">{fmtUSDC(bet.takerStake)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">
              Resolve after <span className="text-gray-600">(<LocalTz />)</span>
            </div>
            <div>{fmtTime(bet.promptAfter)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">Deadline</div>
            <div>{fmtTime(bet.deadline)}</div>
          </div>
          <div className="col-span-2">
            <div className="text-xs text-gray-500">Creator</div>
            <div className="font-mono">{shortAddr(bet.creator)}</div>
          </div>
          {bet.taker !== "0x0000000000000000000000000000000000000000" && (
            <div className="col-span-2">
              <div className="text-xs text-gray-500">Taker</div>
              <div className="font-mono">{shortAddr(bet.taker)}</div>
            </div>
          )}
        </div>

        {/* Wrong-network warning — chainId is checked here so the bet info above
            stays readable on any chain, but writes are gated by NetworkGuard. */}
        {address && <NetworkGuardInline />}

        {/* status-aware action area */}
        {status === 0 /* Open */ && (
          <div className="mt-4">
            {isCreator ? (
              <button
                onClick={() =>
                  cancelWrite({
                    address: BETMARKET_ADDRESS,
                    abi: BETMARKET_ABI,
                    functionName: "cancel",
                    chainId: base.id,
                    args: [betId],
                  })
                }
                disabled={cancelPending || cancelConfirming}
                className="w-full bg-red-700 hover:bg-red-600 disabled:bg-gray-700 text-white font-medium py-3 rounded"
              >
                {cancelPending
                  ? "Confirm in wallet..."
                  : cancelConfirming
                  ? "Cancelling..."
                  : "Cancel bet (refund stake)"}
              </button>
            ) : address ? (
              <AcceptPanel betId={betId} takerStake={bet.takerStake} />
            ) : (
              <p className="text-gray-500 text-sm">Connect a wallet to accept this bet.</p>
            )}

            {isCreator && (
              <div className="mt-4 pt-4 border-t border-gray-800">
                <div className="text-xs text-gray-500 mb-1">Share link</div>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={shareUrl}
                    className="flex-1 bg-gray-800 border border-gray-700 rounded p-2 text-xs font-mono"
                  />
                  <button
                    onClick={() => navigator.clipboard.writeText(shareUrl)}
                    className="bg-gray-800 hover:bg-gray-700 px-3 rounded text-sm"
                  >
                    Copy
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {status === 1 /* Matched */ && (
          <ResolutionPanel betId={betId} promptId={bet.promptId} deadline={bet.deadline} />
        )}

        {(status === 2 || status === 3) /* ResolvedYes / ResolvedNo */ && (
          <ResolvedPanel
            isYes={status === 2}
            promptId={bet.promptId}
            creator={bet.creator}
            taker={bet.taker}
            pot={bet.creatorStake + bet.takerStake}
          />
        )}

        {status === 4 /* Refunded */ && (
          <div className="mt-4 bg-gray-800 rounded p-4 text-sm">
            <div className="text-orange-400 font-semibold mb-1">Refunded</div>
            <div className="text-gray-400">
              Either the oracle returned UNDECIDED / unparseable, or the deadline passed without
              fulfillment. Both stakes returned.
            </div>
          </div>
        )}

        {status === 5 /* Cancelled */ && (
          <div className="mt-4 bg-gray-800 rounded p-4 text-sm text-gray-400">
            Cancelled by creator before a taker accepted. Stake refunded.
          </div>
        )}
      </div>
    </main>
  )
}

function ResolvedPanel({
  isYes,
  promptId,
  creator,
  taker,
  pot,
}: {
  isYes: boolean
  promptId: bigint
  creator: string
  taker: string
  pot: bigint
}) {
  const { data: fulfillment } = useReadContract({
    address: CHANCERY_ADDRESS,
    abi: CHANCERY_ABI,
    functionName: "getFulfillment",
    args: [promptId],
  })

  const winner = isYes ? creator : taker
  const verdict = isYes ? "YES" : "NO"

  return (
    <div className="mt-4">
      <div className="bg-green-950/40 border border-green-800 rounded p-4 mb-3">
        <div className="text-green-400 font-semibold mb-1">Verdict: {verdict}</div>
        <div className="text-sm text-gray-300">
          {fmtUSDC(pot)} → <span className="font-mono">{shortAddr(winner)}</span>
        </div>
      </div>
      {fulfillment && fulfillment[1] && (
        <details className="bg-gray-800 rounded p-3 text-sm">
          <summary className="cursor-pointer text-gray-400">Oracle reasoning</summary>
          <pre className="mt-2 whitespace-pre-wrap text-gray-300">{fulfillment[1]}</pre>
        </details>
      )}
    </div>
  )
}
