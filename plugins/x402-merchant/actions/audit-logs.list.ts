import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({
  limit: z.number().int().positive().optional().describe('Page size'),
  offset: z.number().int().min(0).optional().describe('Pagination offset'),
});

export function merchantAuditLogsListAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.audit-logs.list',
    description: 'Get merchant audit logs (profile, address, webhook, key rotation events)',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input: any) {
      const params = new URLSearchParams();
      if (input.limit != null) params.set('limit', String(input.limit));
      if (input.offset != null) params.set('offset', String(input.offset));
      const qs = params.toString();
      return client.get(`/merchant/v1/audit-logs${qs ? `?${qs}` : ''}`, { signal: ctx.signal, accessToken: ctx.accessToken });
    },
  };
}
