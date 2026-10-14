import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({
  merchant_id: z.string().min(1).describe('Unique merchant identifier'),
  name: z.string().min(1).describe('Merchant display name'),
  email: z.string().email().describe('Owner email address'),
  password: z.string().refine((value) => Buffer.byteLength(value, 'utf8') >= 8 && Buffer.byteLength(value, 'utf8') <= 72, 'Password must be 8–72 UTF-8 bytes').describe('Account password'),
  receive_type: z.literal('DIRECT').default('DIRECT').describe('Self-service registration supports DIRECT merchants'),
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
    sensitiveInputFields: ['password'],
    async execute(ctx, input) {
      return client.post('/merchant/v1/auth/register', input, { signal: ctx.signal });
    },
  };
}
