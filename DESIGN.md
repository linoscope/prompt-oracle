# PromptChancery Design

A contract where users request AI prompts and TEE-attested notary agents fulfill them with cryptographically verified responses.

## Actors

- **Requester**: submits a prompt with execution window (promptAfter, deadline)
- **Notary**: a prompt-oracle agent running in a TEE, commits to and fulfills prompt requests
- **Anyone**: can read fulfilled prompts

## Flow

```
1. Requester calls submitPrompt({ prompt, promptAfter, deadline })
   → status: Open

2. Notary calls commitToPrompt(promptId)
   → status: Committed (notary claims the prompt)

3. Notary runs pi -p "<prompt>" inside TEE, gets signed response

4. Notary calls submitProof(promptId, response, signature, signatureChain)
   → contract verifies TEE signature chain (KMS root → app key → derived key)
   → status: Fulfilled

5. If deadline passes and prompt is not fulfilled:
   → prompt is effectively expired (view function checks deadline)
```

## State Machine

```
             commitToPrompt         submitProof
    Open ──────────────────→ Committed ──────────→ Fulfilled
     │
     │ cancelPrompt
     ↓
  Cancelled
```

Prompts past their deadline that are not fulfilled are considered expired (checked in view functions, no explicit state change).

## Data Structures

```solidity
enum Status { Open, Committed, Fulfilled, Cancelled }

// Input from requester
struct PromptRequest {
    string prompt;
    uint256 promptAfter;   // earliest time proof can be submitted
    uint256 deadline;      // latest time proof can be submitted
}

// Stored on-chain
struct Prompt {
    address requester;
    string prompt;
    uint256 createdAt;
    uint256 promptAfter;
    uint256 deadline;
    Status status;
}

struct Commitment {
    address notary;
}

struct Fulfillment {
    address notary;
    string response;
    uint256 fulfilledAt;
}
```

## Interface

```solidity
// Requester
submitPrompt(PromptRequest calldata request) → uint256 promptId
cancelPrompt(uint256 promptId)

// Notary
commitToPrompt(uint256 promptId)
submitProof(
    uint256 promptId,
    string response,
    bytes32 messageHash,
    bytes messageSignature,
    bytes appSignature,
    bytes kmsSignature,
    bytes derivedCompressedPubkey,
    bytes appCompressedPubkey
)

// View
getPrompt(uint256 promptId) → Prompt
getCommitment(uint256 promptId) → Commitment
getFulfillment(uint256 promptId) → Fulfillment
isExpired(uint256 promptId) → bool
```

## Events

```solidity
PromptRequested(uint256 indexed promptId, address requester, string prompt, uint256 promptAfter, uint256 deadline)
PromptCommitted(uint256 indexed promptId, address notary)
PromptFulfilled(uint256 indexed promptId, address notary, string response)
PromptCancelled(uint256 indexed promptId)
```

## Verification

TEE signature chain is verified inline (same logic as TeeVerifier.sol):

1. `ecrecover(appSignature)` → recover app address
2. `ecrecover(kmsSignature)` → must match `kmsRoot`
3. `ecrecover(messageSignature)` → must match derived key address

The contract stores `kmsRoot` and `appId` as immutables, set at construction.

## What the Contract Proves

Given a fulfilled prompt:

- The response was produced by auditable code (compose hash attested by TEE)
- The code ran `pi -p` with exactly the submitted prompt (verifiable from source)
- The response was not tampered with between generation and on-chain submission
- The notary ran on real Intel TDX hardware (KMS signature chain to Intel root)

## Notary Relay

An off-chain Node.js process that connects the PromptChancery contract to the Pi Oracle TEE. It automates the notary side of the flow.

### What It Does

```
1. Listens for PromptRequested events on-chain
2. Sees a new prompt → calls commitToPrompt(promptId)
3. Waits until promptAfter time is reached
4. Calls Pi Oracle TEE endpoint: POST /prompt { prompt }
5. Receives signed response (statement + signatureChain)
6. Calls submitProof(promptId, ...) on-chain with the TEE proof
```

### Architecture

```
PromptChancery (Base)          Notary Relay (Node.js)          Pi Oracle (TEE)
       │                              │                              │
       │  PromptRequested event       │                              │
       │ ────────────────────────────→│                              │
       │                              │                              │
       │  commitToPrompt(promptId)    │                              │
       │ ←────────────────────────────│                              │
       │                              │                              │
       │                              │  (waits until promptAfter)   │
       │                              │                              │
       │                              │  POST /prompt {prompt}       │
       │                              │ ────────────────────────────→│
       │                              │                              │
       │                              │  signed response             │
       │                              │ ←────────────────────────────│
       │                              │                              │
       │  submitProof(promptId, ...)  │                              │
       │ ←────────────────────────────│                              │
       │                              │                              │
       │  status: Fulfilled           │                              │
```

### Configuration

The relay needs:
- **RPC URL**: Base RPC endpoint for reading events and sending transactions
- **Private key**: wallet to pay gas for commitToPrompt and submitProof
- **Contract address**: deployed PromptChancery address
- **TEE URL**: Pi Oracle endpoint (e.g., `https://<appId>-8080.dstack-base-prod5.phala.network`)

### What the Relay Is NOT

The relay is **not** a trusted component. It's a convenience layer that automates the notary workflow. The trust comes from the TEE signature chain, not from the relay. Anyone can run a relay — the contract verifies the TEE proof regardless of who submits it.

A malicious relay could:
- Refuse to fulfill (denial of service) — but another relay can pick it up
- Submit the proof late (after deadline) — contract rejects it

A malicious relay cannot:
- Forge a response (no TEE key)
- Alter the prompt or response (signature chain verification fails)

## Future Extensions

- Fee payment (requester pays notary)
- Commitment expiration (expire stale commitments, re-open prompts)
- Notary staking and slashing
- Allowed notary whitelist per prompt
- Multiple fulfillments per prompt (independent responses from different notaries)
- Max response length
- Prompt categories/tags
