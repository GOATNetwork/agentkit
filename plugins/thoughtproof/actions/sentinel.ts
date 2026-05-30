import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { ThoughtProofAdapter, SentinelVerifyInput, SentinelVerifyOutput } from '../adapters/types';

const inputSchema = z.object({
  claim: z.string().min(1, 'claim must not be empty — the agent reasoning or planned action to verify'),
  context: z.string().optional().describe('Context or instructions the agent was given'),
  task: z.string().optional().describe('The agent task or goal'),
});

/**
 * Pre-execution verification via ThoughtProof Sentinel.
 *
 * Checks agent reasoning and planned actions BEFORE execution.
 * Returns ALLOW (safe to proceed), BLOCK (stop), or UNCERTAIN (escalate to RV).
 *
 * Cost: ~$0.003 per call. Designed for every agent decision cycle.
 */
export function thoughtproofSentinelAction(
  adapter: ThoughtProofAdapter,
): ActionDefinition<SentinelVerifyInput, SentinelVerifyOutput> {
  return {
    name: 'thoughtproof.sentinel',
    description:
      'Pre-execution verification: check agent reasoning before executing an action. ' +
      'Send the agent\'s planned action and reasoning as "claim", get back ALLOW, BLOCK, or UNCERTAIN. ' +
      'Use before every economic decision. Fast (~2s) and cheap (~$0.003). ' +
      'If UNCERTAIN, escalate to thoughtproof.verify for deeper analysis.',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return adapter.sentinelVerify(input, ctx.signal);
    },
  };
}
