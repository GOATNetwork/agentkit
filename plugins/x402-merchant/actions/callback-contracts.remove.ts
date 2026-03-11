import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({
  chain_id: z.number().int().positive().describe('Chain ID of the active callback contract to remove'),
});

export function merchantCallbackContractsRemoveAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.callback-contracts.remove',
    description: 'Remove an active callback contract (owner only, blocked if in-flight orders exist)',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input: any) {
      return client.delete(
        `/merchant/v1/callback-contracts/${input.chain_id}`,
        { signal: ctx.signal, accessToken: ctx.accessToken },
      );
    },
  };
}
