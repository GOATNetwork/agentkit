import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({});

export function merchantDashboardStatsAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.dashboard.stats',
    description: 'Get merchant dashboard statistics (revenue, order counts, recent orders)',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx) {
      return client.get('/merchant/v1/dashboard/stats', { signal: ctx.signal, accessToken: ctx.accessToken });
    },
  };
}
