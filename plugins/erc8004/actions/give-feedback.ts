import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { REPUTATION_REGISTRY_ADDRESS } from './register-agent';

export interface GiveFeedbackInput {
  agentId: string;
  value: number;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: string;
}

export interface GiveFeedbackOutput {
  txHash: string;
}

const inputSchema = z.object({
  agentId: z.string().regex(/^\d+$/, 'agentId must be a numeric string'),
  value: z.number().int(),
  valueDecimals: z.number().int().min(0).max(18),
  tag1: z.string(),
  tag2: z.string(),
  endpoint: z.string(),
  feedbackURI: z.string(),
  feedbackHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'feedbackHash must be a bytes32 hex string'),
});

const GIVE_FEEDBACK_ABI = [
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
];

export function erc8004GiveFeedbackAction(
  wallet: WalletProvider,
): ActionDefinition<GiveFeedbackInput, GiveFeedbackOutput> {
  return {
    name: 'erc8004.give_feedback',
    description: 'Submit feedback for an agent in the ERC-8004 Reputation Registry. Value is a signed integer with decimals (e.g. value=87, decimals=0 for a score of 87; value=9977, decimals=2 for 99.77%).',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.writeContract(
        REPUTATION_REGISTRY_ADDRESS,
        GIVE_FEEDBACK_ABI,
        'giveFeedback',
        [
          BigInt(input.agentId),
          input.value,
          input.valueDecimals,
          input.tag1,
          input.tag2,
          input.endpoint,
          input.feedbackURI,
          input.feedbackHash,
        ],
        undefined,
        { signal: ctx.signal },
      );
    },
  };
}
