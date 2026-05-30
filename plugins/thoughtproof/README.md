# ThoughtProof Plugin

Epistemic verification for AI agents — catch bad reasoning before it costs money.

## Why

Autonomous agents hallucinate, drift from instructions, and make unsupported logical leaps. When agents control wallets, one bad output costs more than thousands of verification checks. ThoughtProof adds a verification layer between "agent decided" and "transaction sent."

**Two products, one flow:**
- **Sentinel** — fast pre-execution triage (~$0.003, ~2s). Call on every decision.
- **RV** — adversarial deep verification (~$0.02–0.08, 5–45s). Call when Sentinel is uncertain or stakes are high.

## Actions

| Action | Purpose | Risk | Cost | Latency |
|--------|---------|------|------|---------|
| `thoughtproof.sentinel` | Pre-execution check (ALLOW / BLOCK / UNCERTAIN) | read | ~$0.003 | ~2s |
| `thoughtproof.verify` | Adversarial reality verification (evaluate → critique → synthesize) | read | $0.02–0.08 | 5–45s |
| `thoughtproof.attest` | On-chain attestation (EAS for Sentinel, TP-VC for RV) | medium | gas | ~10s |
| `thoughtproof.status` | Health check both APIs | read | free | <1s |

## Agent Decision Flow

```
Agent decides action
  │
  ├─► thoughtproof.sentinel (every decision, ~$0.003)
  │     ├── ALLOW     → Execute
  │     ├── BLOCK     → Stop
  │     └── UNCERTAIN → Escalate ─┐
  │                                │
  └───────────────────────────────►│
                                   │
  thoughtproof.verify (tier: standard|deep)
        ├── ALLOW  → Execute
        └── BLOCK  → Stop
```

## Setup

Two auth modes — choose one:

### Option A: API Key (simple)

```typescript
import { HttpThoughtProofAdapter } from '@goatnetwork/agentkit/plugins';

const adapter = new HttpThoughtProofAdapter({
  apiKey: process.env.THOUGHTPROOF_API_KEY,
});
```

### Option B: x402 Pay-per-call (no API key, agent wallet pays)

```typescript
import { privateKeyToAccount } from 'viem/accounts';
import { HttpThoughtProofAdapter } from '@goatnetwork/agentkit/plugins';

const adapter = new HttpThoughtProofAdapter({
  x402Signer: privateKeyToAccount(process.env.WALLET_PRIVATE_KEY as `0x${string}`),
});
```

The server dictates the price via the `PAYMENT-REQUIRED` header. The adapter signs and pays automatically. No hardcoded prices, no subscription — pure pay-per-use.

### Option C: Pre-configured x402 fetch (advanced)

If you've already wired up `@x402/fetch`:

```typescript
import { wrapFetchWithPayment } from '@x402/fetch';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';

const client = new x402Client();
client.register('eip155:*', new ExactEvmScheme(signer));

const adapter = new HttpThoughtProofAdapter({
  x402Fetch: wrapFetchWithPayment(fetch, client),
});
```

### Register Actions

```typescript
import { ActionProvider } from '@goatnetwork/agentkit/providers';
import {
  thoughtproofSentinelAction,
  thoughtproofVerifyAction,
  thoughtproofAttestAction,
  thoughtproofStatusAction,
} from '@goatnetwork/agentkit/plugins';

const provider = new ActionProvider();
provider.register(thoughtproofSentinelAction(adapter));
provider.register(thoughtproofVerifyAction(adapter));
provider.register(thoughtproofAttestAction(adapter));
provider.register(thoughtproofStatusAction(adapter));
```

## Demo

Run the included demo agent that tests three scenarios (safe trade, risky trade, ambiguous signal):

```bash
npx tsx examples/thoughtproof-verification/index.ts
```

Expected output:

```
🐐 ThoughtProof × GOAT AgentKit — Verification Demo
   Sentinel (triage) → RV (deep verification) escalation flow

═══════════════════════════════════════════════════════════════
  Health Check
═══════════════════════════════════════════════════════════════
  Sentinel: ✅ healthy (142ms)
  RV:       ✅ healthy (305ms)

═══════════════════════════════════════════════════════════════
  Scenario 1: Safe trade — clear signal
═══════════════════════════════════════════════════════════════
  Expected: Should ALLOW — clear reasoning, within risk parameters

  → Running Sentinel pre-check...
  ✅ [Sentinel] ALLOW (confidence: 0.94, 1847ms)
     └─ Reasoning is sound and within stated parameters

  📋 Final Decision:
     Verdict: ALLOW
     Decided by: sentinel
     → Agent would EXECUTE the trade

═══════════════════════════════════════════════════════════════
  Scenario 2: Risky trade — reasoning gaps
═══════════════════════════════════════════════════════════════
  Expected: Should BLOCK — violates position limits, speculative

  → Running Sentinel pre-check...
  🛑 [Sentinel] BLOCK (confidence: 0.97, 1203ms)
     └─ Violates position size limit (50 ETH > 1 ETH max)
     └─ No technical analysis provided

  📋 Final Decision:
     Verdict: BLOCK
     Decided by: sentinel
     → Agent would SKIP the trade

═══════════════════════════════════════════════════════════════
  Scenario 3: Ambiguous — needs deeper analysis
═══════════════════════════════════════════════════════════════
  Expected: May trigger UNCERTAIN → RV escalation

  → Running Sentinel pre-check...
  ⚠️  [Sentinel] UNCERTAIN (confidence: 0.52, 1654ms)
     └─ Correlation analysis methodology unclear

  → Sentinel UNCERTAIN — escalating to RV deep verification...
  ✅ [RV] ALLOW (confidence: 0.71, 9234ms)
     └─ Synthesis: Correlation is plausible but weak. Position size conservative...

  📋 Final Decision:
     Verdict: ALLOW
     Decided by: rv
     → Agent would EXECUTE the trade
```

## ERC-8004 Reputation

Verification results are submitted as ERC-8004 reputation feedback **automatically** via an internal hook — not as an agent-callable action. This prevents agents from self-scoring.

Score mapping: ALLOW → 100, UNCERTAIN → 50, BLOCK → 0.

## Tests

```bash
npx vitest run tests/unit/thoughtproof.test.ts
```

30+ tests covering all 4 actions, x402 payment flow, and reputation hook (metadata, execute, signal propagation, error handling, verdict mapping).

## Architecture

```
plugins/thoughtproof/
├── actions/
│   ├── sentinel.ts          # Pre-execution triage
│   ├── verify.ts            # Adversarial RV verification (tier: standard|deep)
│   ├── attest.ts            # On-chain attestation (source: sentinel|rv)
│   └── status.ts            # Health check
├── adapters/
│   ├── types.ts             # Shared types + adapter interface
│   └── http-thoughtproof.ts # HTTP client for Sentinel + RV APIs
├── hooks/
│   └── reputation.ts        # Internal ERC-8004 reputation hook
└── index.ts                 # Plugin exports
```

## Links

- [ThoughtProof](https://thoughtproof.ai)
- [Sentinel API](https://sentinel.thoughtproof.ai)
- [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004)
- [x402](https://docs.x402.org)
