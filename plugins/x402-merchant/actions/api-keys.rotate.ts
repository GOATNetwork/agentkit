import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({});

export function merchantApiKeysRotateAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.api-keys.rotate',
    description: 'Rotate API keys (invalidates current keys immediately, owner only). Save the new api_secret from response!',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx) {
      return client.post('/merchant/v1/api-keys/rotate', undefined, { signal: ctx.signal, accessToken: ctx.accessToken });
    },
  };
}
