"use client"

import { useState, useEffect } from "react"
import { useParams } from "next/navigation"
import Link from "next/link"
import { ConnectKitButton } from "connectkit"
import { usePublicClient, useReadContract } from "wagmi"
import { useQuery } from "@tanstack/react-query"
import { parseEventLogs, type PublicClient } from "viem"
import { CONTRACT_ADDRESS, CONTRACT_ABI } from "../../contract"
import { BETMARKET_ADDRESS, BETMARKET_ABI } from "../../betmarket-contract"

const ZERO = "0x0000000000000000000000000000000000000000"
const BASESCAN = "https://basescan.org"

const STATUS_LABELS = ["Open", "Committed", "Fulfilled", "Cancelled"]
const STATUS_COLORS = ["text-yellow-400", "text-blue-400", "text-green-400", "text-gray-500"]

// Base produces a block every 2s, so a stored timestamp pins its block to within
// a couple of blocks. Querying tiny windows keeps us under RPC log-range limits
// (Alchemy's free tier caps eth_getLogs at 10 blocks).
const BLOCK_TIME = 2n
const COMMIT_CHUNK = 10n
const COMMIT_MAX_CHUNKS = 15n

function fmtTime(unix: bigint): string {
  return new Date(Number(unix) * 1000).toLocaleString()
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function fmtCountdown(seconds: number): string {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

type TxInfo = {
  requestedTx?: `0x${string}`
  committedTx?: `0x${string}`
  committedAt?: bigint
  fulfilledTx?: `0x${string}`
  betId?: bigint
  failed: boolean
}

async function findTxs(
  client: PublicClient,
  promptId: bigint,
  createdAt: bigint,
  deadline: bigint,
  fulfilledAt: bigint,
  committed: boolean,
  fromBetMarket: boolean
): Promise<TxInfo> {
  const latest = await client.getBlock()
  const blockAt = (ts: bigint) => {
    const b = latest.number - (latest.timestamp - ts) / BLOCK_TIME
    return b > latest.number ? latest.number : b
  }
  const timeOf = (b: bigint) => latest.timestamp - (latest.number - b) * BLOCK_TIME
  const around = (b: bigint) => ({ fromBlock: b - 2n, toBlock: b + 2n > latest.number ? latest.number : b + 2n })
  const out: TxInfo = { failed: false }

  // Each lookup is independent so one RPC refusal doesn't hide the other links.
  const attempt = async (fn: () => Promise<void>) => {
    try {
      await fn()
    } catch {
      out.failed = true
    }
  }

  const requestedBlock = blockAt(createdAt)
  await attempt(async () => {
    const [requested] = await client.getContractEvents({
      address: CONTRACT_ADDRESS,
      abi: CONTRACT_ABI,
      eventName: "PromptRequested",
      args: { promptId },
      ...around(requestedBlock),
    })
    out.requestedTx = requested?.transactionHash
  })

  if (fulfilledAt > 0n) {
    await attempt(async () => {
      const [fulfilled] = await client.getContractEvents({
        address: CONTRACT_ADDRESS,
        abi: CONTRACT_ABI,
        eventName: "PromptFulfilled",
        args: { promptId },
        ...around(blockAt(fulfilledAt)),
      })
      out.fulfilledTx = fulfilled?.transactionHash
    })
  }

  // The commit has no stored timestamp; it lands between request and fulfillment
  // (or the deadline), usually within seconds, so scan forward in small chunks.
  if (committed) {
    await attempt(async () => {
      const end = fulfilledAt > 0n ? blockAt(fulfilledAt) : blockAt(deadline)
      for (let i = 0n, from = requestedBlock - 2n; i < COMMIT_MAX_CHUNKS && from <= end; i++, from += COMMIT_CHUNK) {
        const to = from + COMMIT_CHUNK - 1n > end ? end : from + COMMIT_CHUNK - 1n
        const [c] = await client.getContractEvents({
          address: CONTRACT_ADDRESS,
          abi: CONTRACT_ABI,
          eventName: "PromptCommitted",
          args: { promptId },
          fromBlock: from,
          toBlock: to,
        })
        if (c) {
          out.committedTx = c.transactionHash
          out.committedAt = timeOf(c.blockNumber)
          break
        }
      }
    })
  }

  // BetMarket submits the prompt inside acceptBet, so the request tx carries BetAccepted.
  if (fromBetMarket && out.requestedTx) {
    await attempt(async () => {
      const receipt = await client.getTransactionReceipt({ hash: out.requestedTx! })
      const [accepted] = parseEventLogs({ abi: BETMARKET_ABI, eventName: "BetAccepted", logs: receipt.logs })
      out.betId = accepted?.args.betId
    })
  }

  return out
}

function TxLink({ hash }: { hash?: `0x${string}` }) {
  if (!hash) return null
  return (
    <a
      href={`${BASESCAN}/tx/${hash}`}
      target="_blank"
      rel="noreferrer"
      className="text-blue-400 hover:underline font-mono text-xs"
    >
      {hash.slice(0, 10)}…
    </a>
  )
}

function AddrLink({ addr }: { addr: string }) {
  return (
    <a
      href={`${BASESCAN}/address/${addr}`}
      target="_blank"
      rel="noreferrer"
      className="text-blue-400 hover:underline font-mono"
    >
      {shortAddr(addr)}
    </a>
  )
}

type StepState = "done" | "active" | "pending" | "missed"

const DOT: Record<StepState, string> = {
  done: "bg-green-500 border-green-500",
  active: "bg-blue-500 border-blue-500 animate-pulse",
  pending: "bg-gray-900 border-gray-600",
  missed: "bg-red-500 border-red-500",
}

function Step({
  state,
  title,
  time,
  children,
  last = false,
}: {
  state: StepState
  title: string
  time?: string
  children?: React.ReactNode
  last?: boolean
}) {
  return (
    <li className="relative pl-7 pb-5">
      {!last && <span className="absolute left-[7px] top-4 bottom-0 w-px bg-gray-700" />}
      <span className={`absolute left-0 top-1 w-[15px] h-[15px] rounded-full border-2 ${DOT[state]}`} />
      <div className="flex justify-between items-baseline gap-3">
        <span className={state === "pending" ? "text-gray-500" : "text-gray-200"}>{title}</span>
        {time && <span className="text-xs text-gray-500 whitespace-nowrap">{time}</span>}
      </div>
      {children && <div className="text-xs text-gray-400 mt-1 space-y-1">{children}</div>}
    </li>
  )
}

export default function PromptDetail() {
  const params = useParams<{ id: string }>()
  const promptId = BigInt(params.id)
  const client = usePublicClient()
  const now = useNow()

  const { data: promptData } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: "getPrompt",
    args: [promptId],
    query: { refetchInterval: 5000 },
  })

  const { data: commitment } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: "getCommitment",
    args: [promptId],
    query: { refetchInterval: 5000 },
  })

  const { data: fulfillment } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: "getFulfillment",
    args: [promptId],
    query: { refetchInterval: 5000 },
  })

  const requester = promptData?.[0]
  const createdAt = promptData?.[2] ?? 0n
  const deadline = promptData?.[4] ?? 0n
  const fulfilledAt = fulfillment?.[2] ?? 0n
  const committed = !!commitment && commitment !== ZERO
  const fromBetMarket = requester?.toLowerCase() === BETMARKET_ADDRESS.toLowerCase()

  const { data: txs } = useQuery({
    queryKey: ["prompt-txs", CONTRACT_ADDRESS, promptId.toString(), committed, fulfilledAt.toString()],
    queryFn: () => findTxs(client!, promptId, createdAt, deadline, fulfilledAt, committed, fromBetMarket),
    enabled: !!client && !!requester && requester !== ZERO,
    staleTime: Infinity,
    retry: 1,
  })

  if (!promptData) {
    return (
      <main className="max-w-2xl mx-auto px-4 py-8 w-full">
        <p className="text-gray-500">Loading prompt #{params.id}…</p>
      </main>
    )
  }

  const [, prompt, , promptAfter, , status] = promptData
  const statusNum = Number(status)

  // Non-existent prompt: getPrompt returns the default struct with requester==0x0.
  if (requester === ZERO) {
    return (
      <main className="max-w-2xl mx-auto px-4 py-8 w-full">
        <Link href="/" className="text-sm text-gray-500 hover:text-gray-300">
          ← Prompts
        </Link>
        <h1 className="text-2xl font-bold mt-2 mb-4">Prompt #{params.id}</h1>
        <p className="text-gray-500">No prompt at this id.</p>
      </main>
    )
  }

  const isFulfilled = statusNum === 2
  const isCancelled = statusNum === 3
  const isExpired = !isFulfilled && !isCancelled && BigInt(now) > deadline
  const windowOpen = BigInt(now) >= promptAfter
  // promptAfter is computed from the submitter's clock before the tx mines, so a
  // zero delay often lands it before createdAt; the window then opened on request.
  const windowOpensAt = promptAfter > createdAt ? promptAfter : createdAt
  const windowStep = (
    <Step
      state={windowOpen ? "done" : "pending"}
      title={promptAfter > createdAt ? "Response window opens" : "Response window open from request"}
      time={fmtTime(windowOpensAt)}
    />
  )
  const displayStatus = isExpired ? "Expired" : STATUS_LABELS[statusNum]
  const statusColor = isExpired ? "text-red-400" : STATUS_COLORS[statusNum]

  const commitState: StepState = committed ? "done" : isExpired || isCancelled ? "missed" : "active"
  const finalState: StepState = isFulfilled
    ? "done"
    : isExpired || isCancelled
    ? "missed"
    : committed && windowOpen
    ? "active"
    : "pending"
  const finalTitle = isFulfilled
    ? "Fulfilled with TEE proof"
    : isCancelled
    ? "Cancelled by requester"
    : isExpired
    ? "Expired without fulfillment"
    : committed && windowOpen
    ? "Notary querying the TEE…"
    : "Awaiting fulfillment"

  return (
    <main className="max-w-2xl mx-auto px-4 py-8 w-full">
      <div className="flex justify-between items-center mb-8">
        <div>
          <Link href="/" className="text-sm text-gray-500 hover:text-gray-300">
            ← Prompts
          </Link>
          <h1 className="text-2xl font-bold">Prompt #{params.id}</h1>
        </div>
        <ConnectKitButton />
      </div>

      <div className="bg-gray-900 rounded-lg p-6 border border-gray-800">
        <div className="flex justify-between items-start mb-4">
          <span className={`text-sm font-semibold ${statusColor}`}>{displayStatus}</span>
          {!isFulfilled && !isCancelled && !isExpired && (
            <span className="text-xs text-gray-500">
              Deadline in <span className="font-mono text-gray-300">{fmtCountdown(Number(deadline) - now)}</span>
            </span>
          )}
        </div>

        <p className="text-gray-100 whitespace-pre-wrap mb-4">{prompt}</p>

        <div className="grid grid-cols-2 gap-3 text-sm text-gray-400 mb-6">
          <div className="col-span-2">
            <div className="text-xs text-gray-500">Requester</div>
            <div>
              <AddrLink addr={requester!} />
              {fromBetMarket && (
                <span className="text-gray-500">
                  {" "}
                  (BetMarket
                  {txs?.betId !== undefined && (
                    <>
                      {" · "}
                      <Link href={`/bets/${txs.betId}`} className="text-blue-400 hover:underline">
                        bet #{txs.betId.toString()}
                      </Link>
                    </>
                  )}
                  )
                </span>
              )}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500">Execute after</div>
            <div>{fmtTime(promptAfter)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">Deadline</div>
            <div>{fmtTime(deadline)}</div>
          </div>
        </div>

        <h3 className="text-xs text-gray-500 uppercase tracking-wide mb-3">Timeline</h3>
        <ol>
          <Step state="done" title="Requested" time={fmtTime(createdAt)}>
            <TxLink hash={txs?.requestedTx} />
          </Step>
          {promptAfter <= createdAt && windowStep}
          <Step
            state={commitState}
            title={committed ? "Notary committed" : "Waiting for a notary to commit"}
            time={txs?.committedAt ? fmtTime(txs.committedAt) : undefined}
          >
            {committed && (
              <div>
                Notary <AddrLink addr={commitment!} /> <TxLink hash={txs?.committedTx} />
              </div>
            )}
          </Step>
          {promptAfter > createdAt && windowStep}
          <Step
            state={finalState}
            title={finalTitle}
            time={isFulfilled ? fmtTime(fulfilledAt) : isExpired ? fmtTime(deadline) : undefined}
            last
          >
            {isFulfilled && fulfillment && (
              <div>
                Signature chain verified on chain against the TEE app id · <TxLink hash={txs?.fulfilledTx} />
              </div>
            )}
          </Step>
        </ol>
        {txs?.failed && (
          <p className="text-xs text-gray-600 mb-2">Transaction links unavailable (RPC refused the log query).</p>
        )}

        {isFulfilled && fulfillment && (
          <div className="bg-gray-800 rounded p-4 border border-gray-700">
            <div className="text-xs text-green-400 font-semibold mb-2">Response</div>
            <pre className="text-gray-100 whitespace-pre-wrap font-sans text-sm">{fulfillment[1]}</pre>
            <div className="text-xs text-gray-500 mt-2">
              Notary <AddrLink addr={fulfillment[0]} /> · {fmtTime(fulfilledAt)}
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
