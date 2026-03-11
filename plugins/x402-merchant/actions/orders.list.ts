import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({
  limit: z.number().int().positive().optional().describe('Page size (default server-defined)'),
  offset: z.number().int().min(0).optional().describe('Pagination offset'),
  status: z.string().optional().describe('Filter by order status (e.g. PAYMENT_CONFIRMED)'),
  flow: z.string().optional().describe('Filter by payment flow (e.g. ERC20_DIRECT)'),
  chain_id: z.number().int().optional().describe('Filter by chain ID'),
  from: z.string().optional().describe('Start date filter (ISO 8601)'),
  to: z.string().optional().describe('End date filter (ISO 8601)'),
});

export function merchantOrdersListAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.orders.list',
    description: 'List x402 merchant orders with optional filters (status, flow, chain, date range)',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input: any) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(input)) {
        if (v != null) params.set(k, String(v));
      }
      const qs = params.toString();
      return client.get(`/merchant/v1/orders${qs ? `?${qs}` : ''}`, { signal: ctx.signal, accessToken: ctx.accessToken });
    },
  };
}
