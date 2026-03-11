import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({
  submission_id: z.string().min(1).describe('UUID of the pending submission to cancel'),
});

export function merchantCallbackContractsCancelSubmissionAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.callback-contracts.cancel-submission',
    description: 'Cancel a pending callback contract submission (owner only)',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input: any) {
      return client.delete(
        `/merchant/v1/callback-contracts/submissions/${encodeURIComponent(input.submission_id)}`,
        { signal: ctx.signal, accessToken: ctx.accessToken },
      );
    },
  };
}
