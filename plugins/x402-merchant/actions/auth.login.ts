import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({
  email: z.string().email().describe('Account email address'),
  password: z.string().min(1).describe('Account password'),
});

export function merchantAuthLoginAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.auth.login',
    description: 'Login to x402 merchant portal and obtain access/refresh tokens',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      const result = await client.post('/merchant/v1/auth/login', input, ctx.signal);
      if (result.access_token) {
        client.setAccessToken(result.access_token);
      }
      return result;
    },
  };
}
