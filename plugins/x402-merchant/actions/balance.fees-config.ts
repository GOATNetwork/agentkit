import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({});

export function merchantBalanceFeesConfigAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.balance.fees-config',
    description: 'Get x402 merchant fee configuration per chain',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx) {
      return client.get('/merchant/v1/fees/config', { signal: ctx.signal, accessToken: ctx.accessToken });
    },
  };
}
