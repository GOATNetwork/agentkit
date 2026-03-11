import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({
  order_id: z.string().min(1).describe('Order UUID'),
});

export function merchantOrdersGetAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.orders.get',
    description: 'Get x402 merchant order details (includes payment and payout info)',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input: any) {
      return client.get(`/merchant/v1/orders/${encodeURIComponent(input.order_id)}`, { signal: ctx.signal, accessToken: ctx.accessToken });
    },
  };
}
