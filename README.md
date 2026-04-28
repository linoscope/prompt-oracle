# Prompt Oracle: TEE-Attested AI Agent

Run an LLM inside a TEE and get cryptographically signed responses. Verifiers can confirm on-chain that a specific prompt produced a specific response, with no tampering.

## How It Works

```
User sends prompt
  │
  ▼
TD (TEE):
  1. Receives prompt via POST /prompt
  2. Runs: pi -p "<prompt>" (calls Claude via Anthropic API)
  3. Captures response
  4. Signs { prompt, response, timestamp } with KMS-derived key
  │
  ▼
Verifier:
  Checks signature chain → KMS root → app key → derived key → signed data
  "This exact prompt produced this exact response inside audited code on real TDX hardware"
```

## What This Proves

- The code is auditable (compose hash attested)
- The prompt was passed to pi exactly as submitted — no hidden system prompt injection
- The response wasn't altered between generation and signing
- Pi ran with `--no-tools --no-session --no-extensions` (pure prompt, no agent actions)

## Prerequisites

- Docker
- Node.js
- [Phala CLI](https://docs.phala.network/) (`npm install -g @phala/cloud-cli`)
- [Foundry](https://getfoundry.sh/) (for on-chain verification)
- Python 3 with `eth-keys` and `eth-utils` (`pip install eth-keys eth-utils`)
- An Anthropic API key (`ANTHROPIC_API_KEY`)
- A wallet with ETH on Base (for contract deployment)

## Test Locally (Simulator)

### 1. Start the simulator

```bash
phala simulator start
```

### 2. Build and run

```bash
docker buildx use default
docker compose build app

docker run --rm -p 8080:8080 \
  -e DSTACK_SIMULATOR_ENDPOINT=/var/run/dstack.sock \
  -e XAI_API_KEY=xai-... \
  -v ~/.phala-cloud/simulator/0.5.3/dstack.sock:/var/run/dstack.sock \
  prompt-oracle-app
```

### 3. Test

```bash
# App info
curl http://localhost:8080/

# Send a prompt
curl -X POST -d '{"prompt":"What is 2+2? Answer in one word."}' http://localhost:8080/prompt
```

Example response:

```json
{
  "statement": {
    "source": "grok",
    "model": "grok-4.20-0309-reasoning",
    "prompt": "What is 2+2? Answer in one word.",
    "response": "Four",
    "timestamp": 1776320182544
  },
  "messageHash": "0x4236...",
  "signature": "0xa499...",
  "signatureChain": {
    "derivedPubkey": "0x02ed...",
    "appSignature": "0x373a...",
    "kmsSignature": "0x2f43..."
  },
  "signerAddress": "0x2295a3B84F1EFBE032562A1976BaA101aF42213b"
}
```

### 4. Verify signature chain (simulator)

```bash
# Save a response first
curl -s -X POST -d '{"prompt":"hello"}' http://localhost:8080/prompt > response.json

# Simulator KMS root: 0x8f2cF602C9695b23130367ed78d8F557554de7C5
python3 -c "
from eth_keys import keys
from eth_utils import keccak
import json

data = json.load(open('response.json'))
chain = data['signatureChain']

# Step 1: Recover app pubkey from app signature
derived_pubkey = chain['derivedPubkey'].replace('0x', '')
app_sig = chain['appSignature'].replace('0x', '')
msg = f'ethereum:{derived_pubkey}'
msg_hash = keccak(text=msg)
sig = keys.Signature(bytes.fromhex(app_sig))
app_pubkey = sig.recover_public_key_from_msg_hash(msg_hash)
print(f'Step 1 - App address: {app_pubkey.to_checksum_address()}')

# Step 2: Verify KMS signature
app_id = data.get('appId', '')
kms_sig = chain['kmsSignature'].replace('0x', '')
kms_message = b'dstack-kms-issued:' + bytes.fromhex(app_id) + app_pubkey.to_compressed_bytes()
kms_hash = keccak(kms_message)
kms_sig_obj = keys.Signature(bytes.fromhex(kms_sig))
recovered_kms = kms_sig_obj.recover_public_key_from_msg_hash(kms_hash)
print(f'Step 2 - KMS root: {recovered_kms.to_checksum_address()}')
print(f'         Expected: 0x8f2cF602C9695b23130367ed78d8F557554de7C5')
print(f'         Match: {recovered_kms.to_checksum_address() == \"0x8f2cF602C9695b23130367ed78d8F557554de7C5\"}')
"
```

### 5. Clean up

If you ran in the foreground, just Ctrl+C. If you ran with `-d` (background):

```bash
docker stop $(docker ps -q --filter ancestor=prompt-oracle-app)
```

To stop the simulator:

```bash
phala simulator stop
```

## Deploy to Phala Cloud (Real TDX + Base)

### 1. Deploy

```bash
export PRIVATE_KEY="0x<your-key-with-ETH-on-Base>"

phala deploy -n prompt-oracle -c docker-compose.yaml \
  --kms base \
  --private-key "$PRIVATE_KEY" \
  -e XAI_API_KEY=xai-...
```

Save the **App ID** from the output. The deploy command also creates an AppAuth contract on Base.

### 2. Wait for CVM to come online

```bash
phala cvms get prompt-oracle --json | jq '.status'
# Wait until "running" — may take several minutes (npm install inside TD)
```

### 3. Test

```bash
# App info
curl https://<appId>-8080.dstack-base-prod5.phala.network/

# Send a prompt and save response
curl -s -X POST \
  -d '{"prompt":"What is 2+2? Answer in one word."}' \
  https://<appId>-8080.dstack-base-prod5.phala.network/prompt > response.json

cat response.json | python3 -m json.tool
```

### 4. Recover app pubkey

```bash
python3 -c "
from eth_keys import keys
from eth_utils import keccak
import json

data = json.load(open('response.json'))
chain = data['signatureChain']

derived_pubkey = chain['derivedPubkey'].replace('0x', '')
app_sig = chain['appSignature'].replace('0x', '')

msg = f'ethereum:{derived_pubkey}'
msg_hash = keccak(text=msg)
sig = keys.Signature(bytes.fromhex(app_sig))
app_pubkey = sig.recover_public_key_from_msg_hash(msg_hash)
print(f'App pubkey: 0x{app_pubkey.to_compressed_bytes().hex()}')
"
```

Save the output — you'll need it for on-chain verification.

### 5. Deploy TeeVerifier.sol to Base

```bash
# Pad your appId to bytes32 (append zeros to 64 hex chars)
# Example: appId "d0d6e8e3..." → "0xd0d6e8e3...000000000000000000000000"

forge create TeeVerifier.sol:TeeVerifier \
  --broadcast \
  --rpc-url https://mainnet.base.org \
  --private-key $PRIVATE_KEY \
  --constructor-args \
    0x52d3CF51c8A37A2CCfC79bBb98c7810d7Dd4CE51 \
    0x<appId>000000000000000000000000
```

Save the **Deployed to** address.

### 6. Verify on-chain

Extract values from response.json:

```bash
cat response.json | jq -r '"messageHash: " + .messageHash, "signature: " + .signature, "appSignature: " + .signatureChain.appSignature, "kmsSignature: " + .signatureChain.kmsSignature, "derivedPubkey: " + .signatureChain.derivedPubkey'
```

Call verify on Base (replace values from above + app pubkey from step 4):

```bash
cast call <DEPLOYED_CONTRACT> \
  "verify(bytes32,bytes,bytes,bytes,bytes,bytes,string)(bool)" \
  <messageHash> \
  <signature> \
  <appSignature> \
  <kmsSignature> \
  <derivedPubkey> \
  <appPubkey> \
  "ethereum" \
  --rpc-url https://mainnet.base.org
```

Should return `true`.

### 7. Clean up

```bash
phala cvms delete prompt-oracle
```

## Files

```
prompt-oracle/
├── docker-compose.yaml    # Build config, env vars, inline app code
├── TeeVerifier.sol        # On-chain signature verification contract
├── foundry.toml           # Foundry config for contract compilation
└── README.md
```

## Key Addresses

| | Address |
|---|---|
| KMS Root (Simulator) | `0x8f2cF602C9695b23130367ed78d8F557554de7C5` |
| KMS Root (Base) | `0x52d3CF51c8A37A2CCfC79bBb98c7810d7Dd4CE51` |
| DstackKms (Base) | `0x2f83172A49584C017F2B256F0FB2Dca14126Ba9C` |

## Pi Agent Flags

The oracle runs pi with these flags for auditability:

| Flag | Purpose |
|---|---|
| `-p` | Non-interactive print mode |
| `--provider anthropic` | Uses Claude via Anthropic API |
| `--model claude-sonnet-4-20250514` | Specific model version |
| `--no-tools` | No file read/write/bash (pure prompt) |
| `--no-session` | No state between calls |
| `--no-extensions` | No plugins |
| `--no-skills` | No skill files |
| `--no-prompt-templates` | No prompt templates |
| `--no-themes` | No themes |
| `--mode text` | Plain text output |

A verifier can audit the source code and confirm these flags are used — the TEE attestation proves this exact code is running.
