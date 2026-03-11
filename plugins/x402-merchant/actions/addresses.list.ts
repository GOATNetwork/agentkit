import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({});

export function merchantAddressesListAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.addresses.list',
    description: 'List x402 merchant receiving addresses',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx) {
      return client.get('/merchant/v1/addresses', { signal: ctx.signal, accessToken: ctx.accessToken });
    },
  };
}
