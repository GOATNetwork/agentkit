import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({
  merchant_id: z.string().min(1).describe('Unique merchant identifier'),
  name: z.string().min(1).describe('Merchant display name'),
  email: z.string().email().describe('Owner email address'),
  password: z.string().min(6).describe('Account password'),
  receive_type: z.enum(['DIRECT', 'DELEGATE']).describe('Payment receive type'),
});

export function merchantAuthRegisterAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.auth.register',
    description: 'Register a new merchant on the x402 merchant portal (pending admin approval)',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return client.post('/merchant/v1/auth/register', input, { signal: ctx.signal });
    },
  };
}
