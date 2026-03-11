import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({});

export function merchantSupportedTokensListAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.supported-tokens.list',
    description: 'List system-supported chains and tokens (chain_id, symbol, decimals, explorer)',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx) {
      return client.get('/merchant/v1/supported-tokens', { signal: ctx.signal, accessToken: ctx.accessToken });
    },
  };
}
