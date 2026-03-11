import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const inputSchema = z.object({
  chain_id: z.number().int().positive().describe('Chain ID of the address to remove'),
  symbol: z.string().min(1).describe('Token symbol (e.g. USDC)'),
});

export function merchantAddressesRemoveAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.addresses.remove',
    description: 'Remove a receiving address by chain and token symbol (owner only)',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input: any) {
      return client.delete(
        `/merchant/v1/addresses/${input.chain_id}/${encodeURIComponent(input.symbol)}`,
        { signal: ctx.signal, accessToken: ctx.accessToken },
      );
    },
  };
}
