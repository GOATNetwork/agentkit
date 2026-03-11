import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({});

export function merchantApiKeysGetAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.api-keys.get',
    description: 'View API key info (secret is masked)',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx) {
      return client.get('/merchant/v1/api-keys', { signal: ctx.signal, accessToken: ctx.accessToken });
    },
  };
}
