import { test, expect } from "./fixtures/burner"
import { createPublicClient, formatEther, http, parseAbi } from "viem"
import { base } from "viem/chains"
import { CONTRACT_ADDRESS } from "../../src/app/contract"

// Tag each run with a nonce so we can find OUR submission unambiguously even when
// public Base RPC read-lag delays the page's nextPromptId refetch.
const TEST_PROMPT = `What is 2+2? (e2e ${Date.now()})`
const RPC = process.env.BASE_RPC || "https://mainnet.base.org"
const ABI = parseAbi(["function nextPromptId() view returns (uint256)"])

test("PromptChancery UI: connect, submit prompt to Base mainnet, verify on chain", async ({
  page,
  burner,
}) => {
  test.setTimeout(180_000)

  const pub = createPublicClient({ chain: base, transport: http(RPC) })

  // Pre-flight: burner needs gas to submit a real tx.
  const balance = await pub.getBalance({ address: burner.address })
  expect(
    balance > 0n,
    `Burner ${burner.address} has 0 ETH on Base — fund it before running this test (~0.001 ETH covers ~1500 runs).`
  ).toBe(true)
  console.log(`Burner ${burner.address}: ${formatEther(balance)} ETH`)

  // Snapshot the next promptId so we can find our submission afterwards.
  const expectedPromptId = await pub.readContract({
    address: CONTRACT_ADDRESS,
    abi: ABI,
    functionName: "nextPromptId",
  })

  // ─── Step 1 — disconnected dapp ──────────────────────────────────────
  await page.goto("/")
  await page.waitForLoadState("networkidle")
  await test.info().attach("01-disconnected.png", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  })
  await expect(page.locator("main")).toMatchAriaSnapshot({ name: "01-disconnected.aria.yml" })

  // ─── Step 2 — open ConnectKit modal ──────────────────────────────────
  await page.getByRole("button", { name: /connect wallet/i }).click()
  await page.waitForTimeout(300)
  await test.info().attach("02-connectkit-modal.png", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  })
  await expect(page.locator("body")).toMatchAriaSnapshot({ name: "02-connectkit-modal.aria.yml" })

  // ─── Step 3 — pick MetaMask (our burner announces as one) ────────────
  await page.getByRole("button", { name: /^metamask$/i }).click()
  await page.waitForFunction(
    (addr) => document.body.innerText.toLowerCase().includes(addr.slice(2, 6).toLowerCase()),
    burner.address,
    { timeout: 15_000 }
  )
  await test.info().attach("03-connected.png", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  })
  await expect(page.locator("main")).toMatchAriaSnapshot({ name: "03-connected.aria.yml" })

  // ─── Step 4 — fill the submit form ───────────────────────────────────
  // Skipping aria snapshot here: the form has dynamic content (per-run tx hash
  // residue isn't a concern thanks to localStorage clear, but Playwright's
  // auto-generated regex YAML for the deadline spinbutton doesn't round-trip).
  // The PNG screenshot in the report is the visual record.
  await page.getByPlaceholder("Enter your prompt...").fill(TEST_PROMPT)
  await test.info().attach("04-form-filled.png", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  })
  await expect(page.getByPlaceholder("Enter your prompt...")).toHaveValue(TEST_PROMPT)

  // ─── Step 5 — submit, burner signs, tx lands on Base ─────────────────
  await page.getByRole("button", { name: "Submit Prompt" }).click()
  // Match the success message format with a regex over the tx hash so the
  // assertion holds across runs (each run's hash differs).
  await expect(page.getByText(/Prompt submitted! Tx: 0x[0-9a-f]{16}/i)).toBeVisible({
    timeout: 60_000,
  })
  await test.info().attach("05-tx-confirmed.png", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  })

  // ─── Step 6 — new prompt appears in the list ─────────────────────────
  // Find our submission by its unique nonce-tagged text. Generous timeout because
  // the dapp polls nextPromptId every 5s via public Base RPC, which has read-lag.
  // No aria snapshot here: each run produces a unique prompt text + timestamps.
  await expect(page.getByText(TEST_PROMPT)).toBeVisible({ timeout: 90_000 })
  await test.info().attach("06-prompt-on-chain.png", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  })
  console.log(`✓ Prompt #${expectedPromptId} submitted to Base mainnet (text: ${TEST_PROMPT})`)
})
