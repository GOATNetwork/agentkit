import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({
  webhook_id: z.string().min(1).describe('Webhook UUID to delete'),
});

export function merchantWebhooksDeleteAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.webhooks.delete',
    description: 'Delete a webhook endpoint (owner only)',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input: any) {
      return client.delete(
        `/merchant/v1/webhooks/${encodeURIComponent(input.webhook_id)}`,
        { signal: ctx.signal, accessToken: ctx.accessToken },
      );
    },
  };
}
