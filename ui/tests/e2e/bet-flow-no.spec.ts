import { twoBurnerTest as test, twoBurnerExpect as expect } from "./fixtures/burner"
import {
  createPublicClient,
  formatEther,
  formatUnits,
  http,
  parseAbi,
  parseUnits,
} from "viem"
import { base } from "viem/chains"
import { BETMARKET_ADDRESS as BETMARKET } from "../../src/app/betmarket-contract"

const RPC = process.env.BASE_RPC || "https://mainnet.base.org"
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

// Tiny stakes so this stays cheap; total cost per YES run ≈ takerStake + gas.
const STAKE_USDC = "0.01"
const STAKE_WEI = parseUnits(STAKE_USDC, 6)
const NEED_GAS = parseEther("0.0001")

const ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function nextBetId() view returns (uint256)",
])

function parseEther(s: string): bigint {
  return parseUnits(s, 18)
}

test("BetMarket: full NO flow — taker wins after Grok answers NO", async ({
  creatorPage,
  creator,
  takerPage,
  taker,
}) => {
  test.setTimeout(600_000) // up to 10min: chancery fulfillment can lag

  const pub = createPublicClient({ chain: base, transport: http(RPC) })

  // ─── Pre-flight: both burners need ETH + USDC ────────────────────────
  for (const [label, addr, needUsdc] of [
    ["creator", creator.address, STAKE_WEI],
    ["taker", taker.address, STAKE_WEI],
  ] as const) {
    const eth = await pub.getBalance({ address: addr })
    const usdc = await pub.readContract({
      address: USDC,
      abi: ABI,
      functionName: "balanceOf",
      args: [addr],
    })
    expect(
      eth >= NEED_GAS,
      `${label} ${addr} has ${formatEther(eth)} ETH, needs ≥ ${formatEther(NEED_GAS)} on Base`
    ).toBe(true)
    expect(
      usdc >= needUsdc,
      `${label} ${addr} has ${formatUnits(usdc, 6)} USDC, needs ≥ ${STAKE_USDC} on Base`
    ).toBe(true)
  }

  // Tagged with a per-run nonce: avoids stale on-chain prompt collisions.
  const NONCE = Date.now()
  // Question Grok will reliably answer NO: "banana" plainly contains no "z".
  const QUESTION = `Does the word "banana" contain the letter "z"? (bet ${NONCE})`

  // ─── Step 1 — creator opens /bets, lands on disconnected form ────────
  await creatorPage.goto("/bets")
  await creatorPage.waitForLoadState("networkidle")
  await test.info().attach("01-creator-disconnected.png", {
    body: await creatorPage.screenshot({ fullPage: true }),
    contentType: "image/png",
  })

  // ─── Step 2 — connect creator wallet ─────────────────────────────────
  await creatorPage.getByRole("button", { name: /connect wallet/i }).click()
  await creatorPage.waitForTimeout(300)
  await creatorPage.getByRole("button", { name: /^metamask$/i }).click()
  await creatorPage.waitForFunction(
    (a) => document.body.innerText.toLowerCase().includes(a.slice(2, 6).toLowerCase()),
    creator.address,
    { timeout: 15_000 }
  )
  await creatorPage.waitForTimeout(1000)

  // ─── Step 3 — fill the create-bet form ───────────────────────────────
  await creatorPage.getByPlaceholder(/Will linoscope/i).fill(QUESTION)
  // Set short windows for fast resolution: resolve-after = +2min, deadline = +12min
  // datetime-local format: YYYY-MM-DDTHH:MM
  const toLocal = (offsetMin: number) => {
    const d = new Date(Date.now() + offsetMin * 60_000)
    d.setSeconds(0, 0)
    const tz = d.getTimezoneOffset() * 60_000
    return new Date(d.getTime() - tz).toISOString().slice(0, 16)
  }
  await creatorPage.getByLabel(/Resolve after/i).fill(toLocal(2))
  await creatorPage.getByLabel(/Deadline/i).fill(toLocal(12))
  await creatorPage.getByLabel(/Your stake/i).fill(STAKE_USDC)
  await creatorPage.getByLabel(/Taker stake/i).fill(STAKE_USDC)
  await test.info().attach("02-creator-form-filled.png", {
    body: await creatorPage.screenshot({ fullPage: true }),
    contentType: "image/png",
  })

  // ─── Step 4 — approve USDC if needed, then create bet ────────────────
  const approveBtn = creatorPage.getByRole("button", { name: /Approve.*USDC/i })
  if (await approveBtn.isVisible().catch(() => false)) {
    await approveBtn.click()
    // Wait for allowance refresh → button flips to "Create Bet".
    await expect(creatorPage.getByRole("button", { name: /^Create Bet$/ })).toBeVisible({
      timeout: 60_000,
    })
  }

  // Retry the nextBetId read — public Base RPC sometimes rate-limits transiently.
  let expectedBetId: bigint = 0n
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      expectedBetId = await pub.readContract({
        address: BETMARKET,
        abi: ABI,
        functionName: "nextBetId",
      })
      break
    } catch (e) {
      if (attempt === 4) throw e
      await new Promise((r) => setTimeout(r, 3_000))
    }
  }

  await creatorPage.getByRole("button", { name: /^Create Bet$/ }).click()
  // After success the dapp auto-redirects to /bets/<id>; wait for that.
  await expect(creatorPage).toHaveURL(new RegExp(`/bets/${expectedBetId}$`), { timeout: 60_000 })
  await test.info().attach("03-creator-bet-created.png", {
    body: await creatorPage.screenshot({ fullPage: true }),
    contentType: "image/png",
  })

  // ─── Step 5 — taker opens the share link, sees the Open bet ──────────
  await takerPage.goto(`/bets/${expectedBetId}`)
  await takerPage.waitForLoadState("networkidle")
  await expect(takerPage.getByText(QUESTION)).toBeVisible({ timeout: 15_000 })
  await test.info().attach("04-taker-bet-open.png", {
    body: await takerPage.screenshot({ fullPage: true }),
    contentType: "image/png",
  })

  // ─── Step 6 — taker connects + accepts ───────────────────────────────
  await takerPage.getByRole("button", { name: /connect wallet/i }).click()
  await takerPage.waitForTimeout(300)
  await takerPage.getByRole("button", { name: /^metamask$/i }).click()
  await takerPage.waitForFunction(
    (a) => document.body.innerText.toLowerCase().includes(a.slice(2, 6).toLowerCase()),
    taker.address,
    { timeout: 15_000 }
  )

  // Wait for either Approve USDC or Accept bet button to be ready (allowance loaded).
  await expect(
    takerPage.getByRole("button", { name: /Approve.*USDC|Accept bet/i })
  ).toBeVisible({ timeout: 30_000 })

  const takerApprove = takerPage.getByRole("button", { name: /Approve.*USDC/i })
  if (await takerApprove.isVisible().catch(() => false)) {
    await takerApprove.click()
    await expect(takerPage.getByRole("button", { name: /Accept bet/i })).toBeVisible({
      timeout: 60_000,
    })
  }
  // Burner auto-signs in microseconds, so the wagmi isPending → confirming transition
  // can be too fast to assert intermediate button text. Public Base RPC also intermittently
  // rate-limits the broadcast, in which case viem retries silently. Just wait for the
  // page poller (5s interval) to pick up the on-chain status flip.
  await takerPage.getByRole("button", { name: /Accept bet/i }).click()
  await expect(takerPage.getByText(/^Matched$/i)).toBeVisible({ timeout: 180_000 })
  await test.info().attach("05-taker-bet-matched.png", {
    body: await takerPage.screenshot({ fullPage: true }),
    contentType: "image/png",
  })

  // ─── Step 7 — wait for the TEE notary + Grok to fulfill ──────────────
  // The notary picks up PromptRequested via WS or the 60s polling fallback,
  // calls Grok in TEE, and submits the proof. Generous timeout — public RPC
  // also has read lag.
  await expect(creatorPage.getByText(/Oracle responded/i)).toBeVisible({ timeout: 480_000 })
  await test.info().attach("06-oracle-responded.png", {
    body: await creatorPage.screenshot({ fullPage: true }),
    contentType: "image/png",
  })

  // ─── Step 8 — anyone triggers resolve(); taker wins ─────────────────
  await creatorPage.getByRole("button", { name: /Resolve & Pay Out/i }).click()
  await expect(creatorPage.getByText(/Verdict: NO/i)).toBeVisible({ timeout: 60_000 })
  await test.info().attach("07-resolved-no.png", {
    body: await creatorPage.screenshot({ fullPage: true }),
    contentType: "image/png",
  })

  console.log(`✓ Bet #${expectedBetId} resolved NO on Base mainnet`)
})
