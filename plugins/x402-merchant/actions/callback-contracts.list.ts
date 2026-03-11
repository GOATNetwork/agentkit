import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({});

export function merchantCallbackContractsListAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.callback-contracts.list',
    description: 'List callback contracts (active + pending/rejected submissions, DELEGATE mode)',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx) {
      return client.get('/merchant/v1/callback-contracts', { signal: ctx.signal, accessToken: ctx.accessToken });
    },
  };
}
