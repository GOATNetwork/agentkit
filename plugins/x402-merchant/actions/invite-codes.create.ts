import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({
  expires_in_hours: z.number().int().positive().optional().describe('Invite code expiry in hours (default: 72)'),
});

export function merchantInviteCodesCreateAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.invite-codes.create',
    description: 'Create a single-use invite code for a new member (owner only)',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return client.post('/merchant/v1/invite-codes', input, { signal: ctx.signal, accessToken: ctx.accessToken });
    },
  };
}
