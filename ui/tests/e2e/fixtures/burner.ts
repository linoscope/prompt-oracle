import { test as base, type BrowserContext, type Page } from "@playwright/test"
import { config as loadEnv } from "dotenv"
import { createPublicClient, createWalletClient, http } from "viem"
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts"
import { base as baseChain } from "viem/chains"

loadEnv({ path: ".env.test" })

const CREATOR_PK = process.env.TEST_PK as `0x${string}` | undefined
const TAKER_PK = process.env.TAKER_PK as `0x${string}` | undefined
const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org"

if (!CREATOR_PK) {
  throw new Error("TEST_PK missing — populate .env.test")
}

/**
 * Inject a viem-backed EIP-1193 + EIP-6963 provider into a Playwright context.
 * Each context gets its OWN exposed function name so two burners can coexist
 * across two contexts in the same test (creator + taker).
 */
export async function injectBurner(
  context: BrowserContext,
  pk: `0x${string}`,
  bridgeName = "__burnerRequest"
): Promise<PrivateKeyAccount> {
  const account = privateKeyToAccount(pk)
  const wallet = createWalletClient({ account, chain: baseChain, transport: http(BASE_RPC) })
  const pub = createPublicClient({ chain: baseChain, transport: http(BASE_RPC) })

  let connected = false

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await context.exposeFunction(
    bridgeName,
    async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
      switch (method) {
        case "eth_requestAccounts":
          connected = true
          return [account.address]
        case "eth_accounts":
          return connected ? [account.address] : []
        case "eth_chainId":
          return `0x${baseChain.id.toString(16)}`
        case "net_version":
          return String(baseChain.id)
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          return null
        case "personal_sign": {
          const [data] = params as [`0x${string}`, string]
          return await wallet.signMessage({ message: { raw: data } })
        }
        case "eth_sign": {
          const [, data] = params as [string, `0x${string}`]
          return await wallet.signMessage({ message: { raw: data } })
        }
        case "eth_signTypedData_v4": {
          const [, typed] = params as [string, string]
          return await wallet.signTypedData(JSON.parse(typed))
        }
        case "eth_sendTransaction": {
          const [tx] = params as [Parameters<typeof wallet.sendTransaction>[0]]
          return await wallet.sendTransaction(tx)
        }
        default:
          return await pub.transport.request({ method, params })
      }
    }
  )

  await context.addInitScript(
    ({ bridge }: { bridge: string }) => {
      type Listener = (...args: unknown[]) => void
      const listeners: Record<string, Listener[]> = {}
      const provider = {
        isMetaMask: true,
        request: async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
          // @ts-expect-error wired up via exposeFunction
          return await window[bridge]({ method, params })
        },
        on(event: string, fn: Listener) {
          ;(listeners[event] ||= []).push(fn)
        },
        removeListener(event: string, fn: Listener) {
          listeners[event] = (listeners[event] || []).filter((l) => l !== fn)
        },
      }
      // @ts-expect-error
      window.ethereum = provider
      const info = {
        uuid: "00000000-0000-0000-0000-000000000001",
        name: "MetaMask",
        icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E",
        rdns: "io.metamask",
      }
      const announce = () =>
        window.dispatchEvent(
          new CustomEvent("eip6963:announceProvider", {
            detail: Object.freeze({ info, provider }),
          })
        )
      window.addEventListener("eip6963:requestProvider", announce)
      announce()
    },
    { bridge: bridgeName }
  )

  // Clear wagmi's persisted state so each test starts disconnected.
  await context.addInitScript(() => {
    try {
      localStorage.clear()
      sessionStorage.clear()
    } catch {}
  })

  return account
}

// ─── Single-burner fixture (existing PromptChancery test uses this) ────
type Fixtures = { burner: PrivateKeyAccount }

export const test = base.extend<Fixtures>({
  burner: async ({ context }, use) => {
    const account = await injectBurner(context, CREATOR_PK)
    await use(account)
  },
})

export const expect = test.expect

// ─── Two-burner fixture (BetMarket tests) ──────────────────────────────
type TwoBurnerFixtures = {
  creator: PrivateKeyAccount
  creatorPage: Page
  taker: PrivateKeyAccount
  takerPage: Page
}

export const twoBurnerTest = base.extend<TwoBurnerFixtures>({
  creator: async ({ context }, use) => {
    const account = await injectBurner(context, CREATOR_PK)
    await use(account)
  },
  creatorPage: async ({ page }, use) => {
    await use(page)
  },
  taker: [
    async ({ browser }, use) => {
      if (!TAKER_PK) throw new Error("TAKER_PK missing — populate .env.test")
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const account = await injectBurner(ctx, TAKER_PK, "__burnerRequestTaker")
      // Stash the context on the account object so takerPage can retrieve it.
      ;(account as unknown as { _ctx: BrowserContext })._ctx = ctx
      await use(account)
      await ctx.close()
    },
    { scope: "test" },
  ],
  takerPage: async ({ taker }, use) => {
    const ctx = (taker as unknown as { _ctx: BrowserContext })._ctx
    const page = await ctx.newPage()
    await use(page)
  },
})

export const twoBurnerExpect = twoBurnerTest.expect
