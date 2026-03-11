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
    description: 'Register on x402 merchant portal using an invite code (auto-approved). Use the returned access_token in subsequent action calls.',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    sensitiveOutputFields: ['access_token', 'refresh_token'],
    async execute(ctx, input) {
      return client.post('/merchant/v1/auth/register/invite', input, { signal: ctx.signal });
    },
  };
}
