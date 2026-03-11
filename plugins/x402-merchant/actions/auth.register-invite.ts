import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({
  invite_code: z.string().min(1).describe('Invite code issued by merchant owner'),
  email: z.string().email().describe('Email address'),
  password: z.string().min(6).describe('Account password'),
});

export function merchantAuthRegisterInviteAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.auth.register-invite',
    description: 'Register on x402 merchant portal using an invite code (auto-approved)',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      const result = await client.post('/merchant/v1/auth/register/invite', input, ctx.signal);
      if (result.access_token) {
        client.setAccessToken(result.access_token);
      }
      return result;
    },
  };
}
