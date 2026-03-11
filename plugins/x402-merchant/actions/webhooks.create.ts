import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({
  url: z.string().url().describe('Webhook endpoint URL (must be HTTPS, no private IPs)'),
  events: z.array(z.string()).min(1).describe('Event types to subscribe to (e.g. ["order.invoiced"])'),
});

export function merchantWebhooksCreateAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.webhooks.create',
    description: 'Create a new webhook endpoint (owner only). Save the webhook secret from response!',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return client.post('/merchant/v1/webhooks', input, { signal: ctx.signal, accessToken: ctx.accessToken });
    },
  };
}
