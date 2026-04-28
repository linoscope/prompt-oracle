# pi-oracle — agent notes

This directory holds the PromptChancery contract, the TEE notary relay, and the
Next.js UI. The notes below are the load-bearing things future agents will trip
over if they aren't aware.

## Stack at a glance

| Piece | Where | Notes |
|---|---|---|
| `PromptChancery.sol` | `./PromptChancery.sol` | Deployed at `0xE453E01aEF962A836a0B78AbB91a18f01C3d8160` on Base mainnet |
| Notary relay | `./notary-relay.mjs` | Watches contract via WS + polling fallback (60s); calls TEE; submits proof |
| TEE oracle | `./docker-compose.yaml` | Runs in a dstack TDX container, calls `https://api.x.ai/v1/responses` (Grok) |
| UI | `./ui/` | Next.js, wagmi + ConnectKit, talks to Base mainnet only |

The contract is **live on mainnet**. There is no testnet deployment. Any UI test
that submits a prompt is hitting real chain state.

---

## What needs to be running before tests pass

The E2E test reaches across three runtime services. Two of them you start
locally; one is hosted. If any are down, the failure mode differs:

| Service | Where it runs | Test fails if down? | Symptom |
|---|---|---|---|
| **UI dev server** (`next dev`) | `cd ui && npm run dev` → `http://localhost:3000` | **Yes — hard fail** | Playwright can't reach `baseURL`; first `page.goto("/")` errors |
| **Notary relay** (`notary-relay.mjs`) | `cd tutorial/pi-oracle && PRIVATE_KEY=... CONTRACT_ADDRESS=... TEE_URL=... node notary-relay.mjs` | **No** for the current test | Submitted prompt sits in `Open` state on chain. The current step 6 only asserts the prompt text appears in the list, which happens regardless of fulfillment, so the test passes — but the user's prompt stays unanswered until someone restarts the relay |
| **TEE oracle on Phala** (dstack TDX container) | Hosted; the notary `POST`s to `TEE_URL` to get Grok's signed response | **No** for the current test, same as above | Notary relay logs `Failed to call TEE: …`, prompt stays unfulfilled |

**Practical checklist before running `npm run test:e2e`:**

```bash
# Terminal 1: UI dev server (required)
cd tutorial/pi-oracle/ui
npm run dev

# Terminal 2 (optional but expected): notary relay
cd tutorial/pi-oracle
PRIVATE_KEY=… CONTRACT_ADDRESS=0xE453E01aEF962A836a0B78AbB91a18f01C3d8160 \
  TEE_URL=https://… WS_URL=wss://… \
  node notary-relay.mjs

# Terminal 3: tests
cd tutorial/pi-oracle/ui
npm run test:e2e
```

If the test passes but the prompt you just submitted is showing `Open` /
`Committed` instead of `Fulfilled` after a minute, the notary relay or the
Phala TEE is down. The relay's polling fallback (60s) will catch up
automatically once it's back; you don't need to resubmit.

---

## Writing E2E tests for the UI

The UI test suite lives at `./ui/tests/e2e/`. The test runner is Playwright
(`@playwright/test`), and the wallet is a **viem-based EIP-1193 burner** that
the test fixture injects into the page. Do not try to reinstall Synpress /
MetaMask — see "Why not Synpress" below for the history.

### Architecture

```
┌─────────────┐    ┌──────────────┐    ┌─────────────────┐
│ Playwright  │───▶│ Next.js page │───▶│ window.ethereum │
│ test code   │    │  (wagmi +    │    │ (injected viem  │
│ (Node)      │    │  ConnectKit) │    │  EIP-1193)      │
└─────────────┘    └──────────────┘    └────────┬────────┘
                                                │ exposeFunction bridge
                                                ▼
                                       ┌─────────────────┐
                                       │ viem in Node    │
                                       │ signs with PK,  │
                                       │ broadcasts to   │
                                       │ Base mainnet    │
                                       └─────────────────┘
```

The fixture (`tests/e2e/fixtures/burner.ts`) does three things:

1. Builds a viem `WalletClient` with the test private key and a Base RPC.
2. `context.exposeFunction("__burnerRequest", …)` exposes a Node-side handler
   that turns EIP-1193 requests into viem calls (signs locally, forwards reads).
3. `context.addInitScript(…)` injects a `window.ethereum` shim that
   - implements `request({method, params})` by calling `__burnerRequest`
   - announces itself via the EIP-6963 event so wagmi/ConnectKit pick it up
   - clears localStorage so wagmi doesn't replay last-tx state across runs

**Important quirk:** the burner gates `eth_accounts` on a prior
`eth_requestAccounts` call so ConnectKit doesn't auto-connect on EIP-6963
announce. Without this, the disconnected UI state never renders and you
cannot snapshot it. Mirrors real MetaMask behavior.

### Writing a new test

Pattern in `tests/e2e/connect-wallet.spec.ts`:

```ts
import { test, expect } from "./fixtures/burner"

test("…", async ({ page, burner }) => {
  // pre-flight: ensure burner has gas if you'll submit a tx
  // do work
  // assert on stable text + take screenshots; aria snapshots only for
  // structurally stable regions
})
```

The `burner` fixture exposes the `PrivateKeyAccount` so you can read
`burner.address`, derive other clients in viem, etc.

### Snapshots — what to use, what to avoid

Playwright supports two snapshot mechanisms. Use them deliberately:

- **`toMatchAriaSnapshot()`** — accessibility tree as YAML, text-diffable. Great
  for stable structural regions (the disconnected page, the ConnectKit modal,
  the connected header). The page already has many prompt cards with varying
  timestamps; Playwright's regex auto-detection handles those if there are
  multiple varying samples in the same scope.

- **`page.screenshot()` attached via `test.info().attach(...)`** — pixel record,
  embedded in the HTML report for visual review. Always keep these.

**Avoid aria snapshots over regions with embedded random values** (tx hashes,
single timestamps with no other comparators). Playwright's auto-generated regex
YAML doesn't always round-trip — `- spinbutton: /\d+/` may be written
unquoted, then read back as a literal string and fail comparison. Use targeted
text assertions instead:

```ts
await expect(page.getByText(/Prompt submitted! Tx: 0x[0-9a-f]{16}/i)).toBeVisible()
```

### Re-running and updating snapshots

```bash
cd ui
npm run test:e2e          # run, fail on snapshot drift
npm run test:e2e:update   # run and overwrite snapshots; review the diff before committing
npm run test:report       # open the HTML report locally (port 9323)
```

When the user asks "how did the test go?" or "show me the report" — point them
at `npm run test:report`. The report includes embedded screenshots, aria diffs
side-by-side, and the trace viewer.

---

## Test wallet funding

The viem burner is a real key holding real funds on Base. Each test run that
submits a prompt costs ~$0.002 in gas at current Base prices.

- **Address:** `0xc47037a80Aa8AEED7e72ecaF4420D735219CcBaf`
- **Key location:** `ui/.env.test` (gitignored)
- **Fund with:** ETH on Base (any wallet, any source)

When the burner runs out of gas, the test's pre-flight check fails fast with a
clear message:

> Burner 0xc47037… has 0 ETH on Base — fund it before running this test
> (~0.001 ETH covers ~1500 runs).

If you (the agent) need funding to run a test:

1. Run a quick balance check first:
   ```bash
   cd ui
   node --input-type=module -e "
     import { createPublicClient, http, formatEther } from 'viem'
     import { base } from 'viem/chains'
     const c = createPublicClient({ chain: base, transport: http() })
     console.log(formatEther(await c.getBalance({ address: '0xc47037a80Aa8AEED7e72ecaF4420D735219CcBaf' })))
   "
   ```
2. Tell the user the address, network (**Base**), and a reasonable amount
   (0.001 ETH covers thousands of runs).
3. Wait for them to confirm before running anything tx-emitting.

---

## Things to know about real-mainnet testing

- **Each tx-emitting run leaves a real prompt on chain.** The notary picks it up
  and asks Grok to answer it. Don't be surprised by "What is 2+2? (e2e ...)"
  prompts littering the prompt list. Acceptable cost; not a leak.
- **Public Base RPC (`mainnet.base.org`) has read lag.** After a tx confirms,
  the dapp polls `nextPromptId` every 5s, but the public RPC may return stale
  data for ~30s. Use generous timeouts (60–90s) when waiting for the new prompt
  to appear in the UI.
- **Public RPC has rate limits.** The page does many reads; don't pile on with
  test-side reads in a tight loop. If you need lots of reads in tests, plumb in
  an Alchemy/QuickNode endpoint via `BASE_RPC` in `.env.test`.
- **Tag dynamic test data with a per-run nonce.** `Date.now()` in the prompt
  text lets you find your specific submission unambiguously, even when previous
  runs left the same prompt template on chain.

---

## Why not Synpress / real MetaMask

We tried. It does not currently work cleanly with this dapp's stack:

- Synpress 4.1.2 generates a CLI-side cache hash that diverges from the
  Playwright-runtime hash because the test loader rewrites imports
  (`MetaMask` → `_playwright.MetaMask` in `fn.toString()`). Workaround
  is renaming the cache directory after each rebuild; brittle.
- MetaMask 13.x added a "Your wallet is ready!" post-onboarding splash that
  Synpress's `importWallet` doesn't click through, leaving the cached profile
  on the wrong screen.
- With ConnectKit + EIP-6963, MetaMask v13 does not auto-open `notification.html`
  for connect requests under Playwright. `connectToDapp()` times out waiting
  for a notification page that never appears, even with explicit
  `eth_requestAccounts` calls.

The viem burner side-steps all of this and is faster. The trade-off: we don't
exercise MetaMask's own UI, but that isn't this project's code anyway.
