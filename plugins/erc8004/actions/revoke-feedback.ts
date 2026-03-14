import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { getReputationRegistryAddress } from '../addresses';

export interface RevokeFeedbackInput {
  agentId: string;
  feedbackIndex: string;
}

export interface RevokeFeedbackOutput {
  txHash: string;
}

const inputSchema = z.object({
  agentId: z.string().regex(/^\d+$/, 'agentId must be a numeric string'),
  feedbackIndex: z.string().regex(/^\d+$/, 'feedbackIndex must be a numeric string'),
});

const REVOKE_FEEDBACK_ABI = ['function revokeFeedback(uint256 agentId, uint64 feedbackIndex)'];

export function erc8004RevokeFeedbackAction(
  wallet: WalletProvider,
): ActionDefinition<RevokeFeedbackInput, RevokeFeedbackOutput> {
  return {
    name: 'erc8004.revoke_feedback',
    description: 'Revoke previously submitted feedback for an agent in the ERC-8004 Reputation Registry. Only the original feedback submitter can revoke.',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.writeContract(
        getReputationRegistryAddress(ctx.network),
        REVOKE_FEEDBACK_ABI,
        'revokeFeedback',
        [BigInt(input.agentId), BigInt(input.feedbackIndex)],
        undefined,
        { signal: ctx.signal },
      );
    },
  };
}
