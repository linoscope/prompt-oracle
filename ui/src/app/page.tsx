"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { ConnectKitButton } from "connectkit"
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi"
import { useQueryClient } from "@tanstack/react-query"
import { CONTRACT_ADDRESS, CONTRACT_ABI } from "./contract"

const STATUS_LABELS = ["Open", "Committed", "Fulfilled", "Cancelled"]
const STATUS_COLORS = ["text-yellow-400", "text-blue-400", "text-green-400", "text-gray-500"]

function SubmitPrompt() {
  const [prompt, setPrompt] = useState("")
  const [minutesUntilStart, setMinutesUntilStart] = useState("0")
  const [minutesUntilDeadline, setMinutesUntilDeadline] = useState("10")
  const { writeContract, data: hash, isPending } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })
  const queryClient = useQueryClient()

  useEffect(() => {
    if (isSuccess) {
      queryClient.invalidateQueries()
    }
  }, [isSuccess, queryClient])

  const submit = () => {
    if (!prompt.trim()) return
    const now = Math.floor(Date.now() / 1000)
    const promptAfter = now + parseInt(minutesUntilStart) * 60
    const deadline = now + parseInt(minutesUntilDeadline) * 60

    writeContract({
      address: CONTRACT_ADDRESS,
      abi: CONTRACT_ABI,
      functionName: "submitPrompt",
      args: [{ prompt, promptAfter: BigInt(promptAfter), deadline: BigInt(deadline) }],
    })
  }

  useEffect(() => {
    if (isSuccess) {
      setPrompt("")
    }
  }, [isSuccess])

  return (
    <div className="bg-gray-900 rounded-lg p-6 border border-gray-800">
      <h2 className="text-lg font-semibold mb-4">Submit Prompt</h2>
      <textarea
        className="w-full bg-gray-800 border border-gray-700 rounded p-3 text-gray-100 mb-3 resize-none"
        rows={3}
        placeholder="Enter your prompt..."
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div className="flex gap-4 mb-4">
        <div className="flex-1">
          <label className="text-sm text-gray-400 block mb-1">Execute after (minutes from now)</label>
          <input
            type="number"
            min="0"
            className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-gray-100"
            value={minutesUntilStart}
            onChange={(e) => setMinutesUntilStart(e.target.value)}
          />
        </div>
        <div className="flex-1">
          <label className="text-sm text-gray-400 block mb-1">Deadline (minutes from now)</label>
          <input
            type="number"
            min="1"
            className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-gray-100"
            value={minutesUntilDeadline}
            onChange={(e) => setMinutesUntilDeadline(e.target.value)}
          />
        </div>
      </div>
      <button
        onClick={submit}
        disabled={isPending || isConfirming || !prompt.trim()}
        className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2 px-4 rounded transition"
      >
        {isPending ? "Confirm in wallet..." : isConfirming ? "Confirming..." : "Submit Prompt"}
      </button>
      {isSuccess && (
        <p className="text-green-400 text-sm mt-2">Prompt submitted! Tx: {hash?.slice(0, 18)}...</p>
      )}
    </div>
  )
}

function PromptCard({ promptId }: { promptId: number }) {
  const { data: promptData } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: "getPrompt",
    args: [BigInt(promptId)],
    query: { refetchInterval: 5000 },
  })

  const { data: fulfillmentData } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: "getFulfillment",
    args: [BigInt(promptId)],
    query: { refetchInterval: 5000 },
  })

  const { data: expired } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: "isExpired",
    args: [BigInt(promptId)],
    query: { refetchInterval: 5000 },
  })

  if (!promptData) return null

  const [requester, prompt, createdAt, promptAfter, deadline, status] = promptData
  const statusNum = Number(status)
  const isFulfilled = statusNum === 2
  const displayStatus = expired && !isFulfilled ? "Expired" : STATUS_LABELS[statusNum]
  const statusColor = expired && !isFulfilled ? "text-red-400" : STATUS_COLORS[statusNum]

  return (
    <div className="bg-gray-900 rounded-lg p-5 border border-gray-800">
      <div className="flex justify-between items-start mb-3">
        <Link href={`/prompts/${promptId}`} className="text-xs text-gray-500 hover:text-blue-400 font-mono">
          #{promptId} →
        </Link>
        <span className={`text-xs font-semibold ${statusColor}`}>{displayStatus}</span>
      </div>
      <p className="text-gray-200 mb-3">{prompt}</p>
      <div className="text-xs text-gray-500 space-y-1">
        <div>From: {requester.slice(0, 8)}...{requester.slice(-6)}</div>
        <div>Execute after: {new Date(Number(promptAfter) * 1000).toLocaleString()}</div>
        <div>Deadline: {new Date(Number(deadline) * 1000).toLocaleString()}</div>
      </div>
      {isFulfilled && fulfillmentData && (
        <div className="mt-4 bg-gray-800 rounded p-4 border border-gray-700">
          <div className="text-xs text-green-400 font-semibold mb-2">Response</div>
          <p className="text-gray-100">{fulfillmentData[1]}</p>
          <div className="text-xs text-gray-500 mt-2">
            Notary: {fulfillmentData[0].slice(0, 8)}...{fulfillmentData[0].slice(-6)}
            {" · "}
            {new Date(Number(fulfillmentData[2]) * 1000).toLocaleString()}
          </div>
        </div>
      )}
    </div>
  )
}

function PromptList() {
  const { data: nextId } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: "nextPromptId",
    query: { refetchInterval: 5000 },
  })

  const count = Number(nextId || 0)
  const ids = Array.from({ length: count }, (_, i) => count - 1 - i)

  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">Prompts ({count})</h2>
      {count === 0 ? (
        <p className="text-gray-500">No prompts yet. Submit one above.</p>
      ) : (
        <div className="space-y-3">
          {ids.map((id) => (
            <PromptCard key={id} promptId={id} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function Home() {
  const { isConnected } = useAccount()

  return (
    <main className="max-w-2xl mx-auto px-4 py-8 w-full">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-2xl font-bold">PromptChancery</h1>
          <p className="text-sm text-gray-500">
            TEE-attested AI prompt oracle on Base ·{" "}
            <a href="/bets" className="text-blue-400 hover:underline">
              BetMarket
            </a>
          </p>
        </div>
        <ConnectKitButton />
      </div>

      {isConnected && (
        <div className="mb-8">
          <SubmitPrompt />
        </div>
      )}

      <PromptList />
    </main>
  )
}
