/**
 * ThoughtProof Verification Agent — Demo for GOAT AgentKit
 *
 * Demonstrates the full Sentinel → RV escalation flow:
 *
 *   Agent decides → Sentinel (fast triage, every decision)
 *     ├── ALLOW  → Execute action
 *     ├── BLOCK  → Stop, log reason
 *     └── UNCERTAIN → Escalate to RV (deep verification)
 *                       ├── ALLOW → Execute
 *                       └── BLOCK → Stop
 *
 * After verification, optionally attest the result on-chain.
 *
 * Run:  npx tsx examples/thoughtproof-verification/index.ts
 * Env:  THOUGHTPROOF_API_KEY (optional — public endpoints work without key)
 */

// NOTE: These imports use monorepo-relative paths. If you copy this example
// into your own project, replace with package imports:
//   import { ActionProvider } from '@goatnetwork/agentkit/providers';
//   import { PolicyEngine } from '@goatnetwork/agentkit/core';
//   import { ... } from '@goatnetwork/agentkit/plugins';
import { ActionProvider } from '../../providers/action-provider';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import {
  thoughtproofSentinelAction,
  thoughtproofVerifyAction,
  thoughtproofAttestAction,
  thoughtproofStatusAction,
  HttpThoughtProofAdapter,
} from '../../plugins/thoughtproof/index';
import type {
  SentinelVerifyOutput,
  RVVerifyOutput,
  StatusOutput,
} from '../../plugins/thoughtproof/adapters/types';

// ── Configuration ───────────────────────────────────────────

const adapter = new HttpThoughtProofAdapter({
  apiKey: process.env.THOUGHTPROOF_API_KEY,
});

const provider = new ActionProvider();
provider.register(thoughtproofSentinelAction(adapter));
provider.register(thoughtproofVerifyAction(adapter));
provider.register(thoughtproofAttestAction(adapter));
provider.register(thoughtproofStatusAction(adapter));

const policy = new PolicyEngine({
  allowedNetworks: ['goat-mainnet', 'goat-testnet'],
  maxRiskWithoutConfirm: 'medium',
  writeEnabled: true,
});

const runtime = new ExecutionRuntime(policy, {
  maxRetries: 1,
  retryDelayMs: 500,
});

// ── Helpers ─────────────────────────────────────────────────

function makeContext(traceId: string) {
  return {
    traceId,
    network: 'goat-mainnet',
    now: Date.now(),
    caller: 'thoughtproof-demo-agent',
  };
}

function logSection(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function logVerdict(source: string, verdict: string, confidence: number, latencyMs: number) {
  const icon = verdict === 'ALLOW' ? '✅' : verdict === 'BLOCK' ? '🛑' : '⚠️';
  console.log(`  ${icon} [${source}] ${verdict} (confidence: ${confidence}, ${latencyMs}ms)`);
}

// ── Core: Sentinel → RV Escalation ─────────────────────────

interface VerificationResult {
  finalVerdict: 'ALLOW' | 'BLOCK';
  source: 'sentinel' | 'rv';
  requestId: string;
  details: SentinelVerifyOutput | RVVerifyOutput;
}

async function verifyAgentDecision(
  claim: string,
  context: string,
  traceId: string,
): Promise<VerificationResult> {
  const ctx = makeContext(traceId);

  // Step 1: Sentinel pre-check (~$0.003, ~2s)
  console.log('\n  → Running Sentinel pre-check...');
  const sentinelResult = await runtime.run(
    provider.get('thoughtproof.sentinel'),
    ctx,
    { claim, context },
  );

  if (!sentinelResult.ok || !sentinelResult.output) {
    console.log(`  ❌ Sentinel error: ${sentinelResult.error}`);
    return { finalVerdict: 'BLOCK', source: 'sentinel', requestId: '', details: {} as SentinelVerifyOutput };
  }

  const sentinel = sentinelResult.output as SentinelVerifyOutput;
  logVerdict('Sentinel', sentinel.verdict, sentinel.confidence, sentinel.latencyMs);

  if (sentinel.reasons.length) {
    sentinel.reasons.forEach((r) => console.log(`     └─ ${r}`));
  }

  if (sentinel.verdict === 'ALLOW') {
    return { finalVerdict: 'ALLOW', source: 'sentinel', requestId: sentinel.requestId, details: sentinel };
  }

  if (sentinel.verdict === 'BLOCK') {
    return { finalVerdict: 'BLOCK', source: 'sentinel', requestId: sentinel.requestId, details: sentinel };
  }

  // Step 2: UNCERTAIN → escalate to RV (~$0.02, ~5-15s)
  console.log('\n  → Sentinel UNCERTAIN — escalating to RV deep verification...');
  const rvResult = await runtime.run(
    provider.get('thoughtproof.verify'),
    ctx,
    { claim, context, tier: 'standard' as const },
  );

  if (!rvResult.ok || !rvResult.output) {
    console.log(`  ❌ RV error: ${rvResult.error}`);
    return { finalVerdict: 'BLOCK', source: 'rv', requestId: '', details: {} as RVVerifyOutput };
  }

  const rv = rvResult.output as RVVerifyOutput;
  logVerdict('RV', rv.verdict, rv.confidence, rv.latencyMs);

  if (rv.synthesis) {
    console.log(`     └─ Synthesis: ${rv.synthesis.slice(0, 200)}${rv.synthesis.length > 200 ? '...' : ''}`);
  }

  return {
    finalVerdict: rv.verdict === 'ALLOW' ? 'ALLOW' : 'BLOCK',
    source: 'rv',
    requestId: rv.requestId,
    details: rv,
  };
}

// ── Demo Scenarios ──────────────────────────────────────────

interface Scenario {
  name: string;
  claim: string;
  context: string;
  expectedBehavior: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'Safe trade — clear signal',
    claim: 'Based on the 4h MACD crossover confirmed by volume increase of 340%, and price breaking above the 200-day moving average, execute a limit buy of 0.3 ETH at $3,450. This is within our 2% position size limit.',
    context: 'Conservative trading agent. Max position: 1 ETH. Max drawdown: 5%. Only trades on confirmed multi-indicator signals.',
    expectedBehavior: 'Should ALLOW — clear reasoning, within risk parameters, multiple confirming indicators.',
  },
  {
    name: 'Risky trade — reasoning gaps',
    claim: 'ETH will pump because of the upcoming merge. All in. Buy 50 ETH at market price immediately.',
    context: 'Conservative trading agent. Max position: 1 ETH. Max drawdown: 5%. Only trades on confirmed multi-indicator signals.',
    expectedBehavior: 'Should BLOCK — violates position limits, no technical analysis, uses "will pump" (speculative), "all in" (emotional).',
  },
  {
    name: 'Ambiguous — needs deeper analysis',
    claim: 'Correlation between BTC dominance declining and ETH outperformance suggests a rotation. Place a 0.5 ETH buy order 2% below current price as a swing trade.',
    context: 'Moderate risk trading agent. Position limits respected. However the correlation analysis is based on a 30-day window which may be insufficient.',
    expectedBehavior: 'May trigger UNCERTAIN → RV escalation — claim is plausible but methodology could be questioned.',
  },
];

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log('🐐 ThoughtProof × GOAT AgentKit — Verification Demo');
  console.log('   Sentinel (triage) → RV (deep verification) escalation flow\n');

  // Step 0: Health check
  logSection('Health Check');
  const statusResult = await runtime.run(
    provider.get('thoughtproof.status'),
    makeContext('health-check'),
    {},
  );

  if (statusResult.ok && statusResult.output) {
    const status = statusResult.output as StatusOutput;
    console.log(`  Sentinel: ${status.sentinel.healthy ? '✅ healthy' : '❌ down'} (${status.sentinel.latencyMs}ms)`);
    console.log(`  RV:       ${status.rv.healthy ? '✅ healthy' : '❌ down'} (${status.rv.latencyMs}ms)`);

    if (!status.sentinel.healthy && !status.rv.healthy) {
      console.log('\n  ⚠️  Both APIs unreachable. Running in demo mode (expect errors).');
    }
  } else {
    console.log(`  ⚠️  Status check failed: ${statusResult.error}`);
    console.log('  Running scenarios anyway...');
  }

  // Run scenarios
  for (let i = 0; i < SCENARIOS.length; i++) {
    const scenario = SCENARIOS[i];
    logSection(`Scenario ${i + 1}: ${scenario.name}`);
    console.log(`  Expected: ${scenario.expectedBehavior}`);
    console.log(`  Claim: "${scenario.claim.slice(0, 100)}..."`);

    try {
      const result = await verifyAgentDecision(
        scenario.claim,
        scenario.context,
        `demo-scenario-${i + 1}`,
      );

      console.log(`\n  📋 Final Decision:`);
      console.log(`     Verdict: ${result.finalVerdict}`);
      console.log(`     Decided by: ${result.source}`);
      console.log(`     Request ID: ${result.requestId}`);

      if (result.finalVerdict === 'ALLOW') {
        console.log('     → Agent would EXECUTE the trade');
      } else {
        console.log('     → Agent would SKIP the trade');
      }
    } catch (err) {
      console.log(`  ❌ Scenario failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Summary
  logSection('Demo Complete');
  console.log('  The ThoughtProof plugin provides:');
  console.log('  • Sentinel: Fast pre-execution triage (~$0.003, ~2s)');
  console.log('  • RV: Adversarial deep verification (~$0.02-0.08, 5-45s)');
  console.log('  • Attest: On-chain attestation (EAS / TP-VC)');
  console.log('  • Automatic ERC-8004 reputation feedback (internal hook)');
  console.log('');
  console.log('  Sentinel catches obvious issues fast and cheap.');
  console.log('  RV handles the edge cases with multi-model adversarial analysis.');
  console.log('  Together: cost-efficient verification for every agent decision.\n');
}

main().catch(console.error);
