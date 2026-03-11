import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({
  refresh_token: z.string().min(1).describe('Refresh token from login response'),
});

export function merchantAuthRefreshAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.auth.refresh',
    description: 'Refresh x402 merchant portal access token using a refresh token',
    riskLevel: 'low',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      const result = await client.post('/merchant/v1/auth/refresh', input, ctx.signal);
      if (result.access_token) {
        client.setAccessToken(result.access_token);
      }
      return result;
    },
  };
}
