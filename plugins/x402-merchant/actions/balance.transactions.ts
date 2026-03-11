import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({
  limit: z.number().int().positive().optional().describe('Page size'),
  offset: z.number().int().min(0).optional().describe('Pagination offset'),
});

export function merchantBalanceTransactionsAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.balance.transactions',
    description: 'Get x402 merchant balance transactions (paginated)',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input: any) {
      const params = new URLSearchParams();
      if (input.limit != null) params.set('limit', String(input.limit));
      if (input.offset != null) params.set('offset', String(input.offset));
      const qs = params.toString();
      return client.get(`/merchant/v1/balance/transactions${qs ? `?${qs}` : ''}`, { signal: ctx.signal, accessToken: ctx.accessToken });
    },
  };
}
