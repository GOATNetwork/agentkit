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
    description: 'Login to GOAT Flow merchant portal. If mfa_required is true, pass mfa_token and the current TOTP code to auth.totp-verify to obtain access tokens.',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    sensitiveInputFields: ['password'],
    sensitiveOutputFields: ['access_token', 'refresh_token', 'mfa_token'],
    async execute(ctx, input) {
      return client.post('/merchant/v1/auth/login', input, { signal: ctx.signal });
    },
  };
}
