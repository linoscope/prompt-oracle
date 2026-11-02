/**
 * Sanity-check a Notary Core before anchoring a PromptChancery to it.
 *
 * Sends one prompt and replays the contract's signature-chain checks off-chain,
 * so a wrong app id or a rotated KMS root shows up before any gas is spent.
 *
 * Usage:
 *   node script/check-tee.mjs <TEE_URL> [KMS_ROOT]
 */

import { keccak256, encodePacked, concat, toBytes, hexToBytes, recoverAddress, recoverMessageAddress, recoverPublicKey, toHex } from "viem"
import { publicKeyToAddress } from "viem/accounts"

const TEE_URL = (process.argv[2] || "").replace(/\/$/, "")
const KMS_ROOT = process.argv[3] || "0x52d3CF51c8A37A2CCfC79bBb98c7810d7Dd4CE51"

if (!TEE_URL) {
  console.error("Usage: node script/check-tee.mjs <TEE_URL> [KMS_ROOT]")
  process.exit(1)
}

const info = await (await fetch(TEE_URL)).json()
console.log("App id:  ", info.appId)
console.log("Signer:  ", info.signerAddress)
console.log("Model:   ", info.model)

const res = await (await fetch(`${TEE_URL}/prompt`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "What is 2+2? Answer in one word." }),
})).json()
if (res.error) throw new Error(`TEE error: ${res.error}`)
console.log("Response:", JSON.stringify(res.statement.response))

const { derivedPubkey, appSignature, kmsSignature } = res.signatureChain

// App key signed "ethereum:<derived pubkey hex>"
const appHash = keccak256(encodePacked(["string"], [`ethereum:${derivedPubkey.replace("0x", "")}`]))
const appPubkey = await recoverPublicKey({ hash: appHash, signature: appSignature })
const appBytes = hexToBytes(appPubkey)
const appCompressed = toHex(concat([new Uint8Array([appBytes[64] % 2 === 0 ? 0x02 : 0x03]), appBytes.slice(1, 33)]))

// KMS root signed "dstack-kms-issued:" || appId || appCompressedPubkey
const appId = info.appId.startsWith("0x") ? info.appId : `0x${info.appId}`
const kmsHash = keccak256(concat([toBytes("dstack-kms-issued:"), hexToBytes(appId), hexToBytes(appCompressed)]))
const recoveredKms = await recoverAddress({ hash: kmsHash, signature: kmsSignature })

// Derived key signed the message hash (EIP-191)
const messageSigner = await recoverMessageAddress({ message: { raw: res.messageHash }, signature: res.signature })

const kmsOk = recoveredKms.toLowerCase() === KMS_ROOT.toLowerCase()
const msgOk = messageSigner.toLowerCase() === info.signerAddress.toLowerCase()
console.log(`KMS root:  ${recoveredKms} ${kmsOk ? "OK" : `MISMATCH (expected ${KMS_ROOT})`}`)
console.log(`Msg signer: ${messageSigner} ${msgOk ? "OK" : "MISMATCH"}`)
console.log(`App key:   ${publicKeyToAddress(appPubkey)}`)
process.exit(kmsOk && msgOk ? 0 : 1)
