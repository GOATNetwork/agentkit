import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';
import { evmAddress } from '../../../core/schema/validators';

const inputSchema = z.object({
  chain_id: z.number().int().positive().describe('Target chain ID'),
  token_contract: evmAddress.describe('Token contract address'),
  symbol: z.string().min(1).describe('Token symbol (e.g. USDC)'),
  address: evmAddress.describe('Receiving wallet address'),
});

export function merchantAddressesAddAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.addresses.add',
    description: 'Add a receiving address for a chain+token pair (owner only)',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return client.post('/merchant/v1/addresses', input, { signal: ctx.signal, accessToken: ctx.accessToken });
    },
  };
}
