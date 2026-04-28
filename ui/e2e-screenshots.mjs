import { chromium } from "playwright"
import { writeFileSync } from "fs"

const URL = "http://localhost:3001"
const DIR = "/tmp/pi-oracle-screenshots"

async function screenshot(page, name, description) {
  await page.goto(URL)
  await page.waitForTimeout(4000)
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: true })
  console.log(`  ${name}.png — ${description}`)
  return { name, description }
}

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 800, height: 1000 } })
  const shots = []

  console.log("Taking screenshots...\n")

  // Screenshot: Shows both prompts — #0 fulfilled, #1 open
  shots.push(await screenshot(page, "01-prompts-mixed",
    "Prompt #0 fulfilled (Tokyo), Prompt #1 open (waiting for notary)"))

  await browser.close()

  // Build HTML report
  const screenshotHtml = shots.map(s => `
    <h2>${s.description}</h2>
    <div class="screenshot"><img src="${s.name}.png" alt="${s.description}"></div>
  `).join("\n")

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>PromptChancery UI - E2E Screenshots</title>
  <style>
    body { font-family: system-ui; max-width: 900px; margin: 40px auto; padding: 0 20px; background: #111; color: #eee; }
    h1 { border-bottom: 1px solid #333; padding-bottom: 10px; }
    h2 { color: #8b8; margin-top: 40px; font-size: 16px; }
    .screenshot { border: 1px solid #333; border-radius: 8px; overflow: hidden; margin: 16px 0; }
    .screenshot img { width: 100%; display: block; }
    .info { background: #1a1a1a; padding: 16px; border-radius: 8px; margin: 16px 0; font-size: 14px; line-height: 1.8; }
    .info code { color: #8b8; }
    ol { line-height: 2; }
  </style>
</head>
<body>
  <h1>PromptChancery UI - E2E Test Report</h1>
  <div class="info">
    <strong>Contract:</strong> <code>0x724f849e123192746979F2B443029B1056315972</code> (Base mainnet)<br>
    <strong>Pi Oracle TEE:</strong> <code>d0d6e8e34a6c2cc407652e4412965e7a430b4acb</code> (Phala Cloud, real TDX)<br>
    <strong>KMS Root:</strong> <code>0x52d3CF51c8A37A2CCfC79bBb98c7810d7Dd4CE51</code> (Base)
  </div>
  ${screenshotHtml}
  <h2 style="color:#eee">E2E Flow</h2>
  <ol>
    <li>User submitted prompt on-chain via PromptChancery contract</li>
    <li>Notary relay detected PromptRequested event</li>
    <li>Relay committed to the prompt on-chain</li>
    <li>Relay waited for promptAfter window</li>
    <li>Relay called Pi Oracle TEE endpoint (POST /prompt)</li>
    <li>Pi agent (Claude Sonnet) responded inside TDX</li>
    <li>Response signed with KMS-derived key</li>
    <li>Relay submitted TEE-verified proof on-chain</li>
    <li>Contract verified signature chain (KMS root -> app key -> derived key)</li>
    <li>UI displays verified result</li>
  </ol>
</body>
</html>`

  writeFileSync(`${DIR}/report.html`, html)
  console.log(`\nReport: ${DIR}/report.html`)
}

main().catch(console.error)
