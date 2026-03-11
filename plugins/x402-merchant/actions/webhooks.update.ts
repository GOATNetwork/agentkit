import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({
  webhook_id: z.string().min(1).describe('Webhook UUID'),
  url: z.string().url().optional().describe('Updated webhook URL'),
  events: z.array(z.string()).optional().describe('Updated event types'),
  enabled: z.boolean().optional().describe('Enable or disable the webhook'),
});

export function merchantWebhooksUpdateAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.webhooks.update',
    description: 'Update a webhook (toggle enabled, change URL or events, owner only)',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input: any) {
      const { webhook_id, ...body } = input;
      return client.put(
        `/merchant/v1/webhooks/${encodeURIComponent(webhook_id)}`,
        body,
        { signal: ctx.signal, accessToken: ctx.accessToken },
      );
    },
  };
}
