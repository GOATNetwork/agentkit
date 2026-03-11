import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({
  code_id: z.string().min(1).describe('Invite code UUID to revoke'),
});

export function merchantInviteCodesRevokeAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.invite-codes.revoke',
    description: 'Revoke an unused invite code (owner only)',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input: any) {
      return client.delete(
        `/merchant/v1/invite-codes/${encodeURIComponent(input.code_id)}`,
        { signal: ctx.signal, accessToken: ctx.accessToken },
      );
    },
  };
}
