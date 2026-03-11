import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({
  name: z.string().min(1).optional().describe('Updated merchant display name'),
  logo: z.string().url().optional().describe('URL of merchant logo image'),
});

export function merchantProfileUpdateAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.profile.update',
    description: 'Update x402 merchant profile (name and logo only, owner only)',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return client.put('/merchant/v1/profile', input, { signal: ctx.signal, accessToken: ctx.accessToken });
    },
  };
}
