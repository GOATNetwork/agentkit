import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { ThoughtProofAdapter, RVVerifyInput, RVVerifyOutput } from '../adapters/types';

const inputSchema = z.object({
  claim: z.string().min(1, 'claim must not be empty — the agent output or decision to verify'),
  context: z.string().optional().describe('Supporting context, evidence, or source material'),
  tier: z.enum(['standard', 'deep']).default('standard').describe(
    'Verification depth: "standard" (~$0.02, 5-15s) for most decisions, "deep" (~$0.08, 15-45s) for high-stakes',
  ),
  domain: z.string().optional().describe(
    'Domain hint for domain-specific verification profiles (e.g., "finance", "medical", "legal")',
  ),
});

/**
 * Adversarial reality verification via ThoughtProof RV.
 *
 * Three-stage pipeline: evaluate → critique (red-team) → synthesize.
 * Checks whether an agent's output is substantively correct — not just
 * process compliance, but actual factual/logical correctness.
 *
 * Use when:
 * - Sentinel returns UNCERTAIN and you need deeper analysis
 * - High-stakes decisions where correctness matters (trading, compliance)
 * - Post-execution audit of agent reasoning quality
 *
 * Cost: ~$0.02 (standard) or ~$0.08 (deep) per call.
 */
export function thoughtproofVerifyAction(
  adapter: ThoughtProofAdapter,
): ActionDefinition<RVVerifyInput, RVVerifyOutput> {
  return {
    name: 'thoughtproof.verify',
    description:
      'Adversarial reality verification: check whether an agent output is substantively correct. ' +
      'Uses a multi-model evaluate → red-team critique → synthesize pipeline. ' +
      'Set tier="standard" for most checks (~$0.02, 5-15s), tier="deep" for high-stakes (~$0.08, 15-45s). ' +
      'Use after Sentinel returns UNCERTAIN, or directly for critical decisions. ' +
      'Returns verdict (ALLOW/BLOCK/UNCERTAIN), confidence score, and full reasoning chain.',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return adapter.rvVerify(input, ctx.signal);
    },
  };
}
