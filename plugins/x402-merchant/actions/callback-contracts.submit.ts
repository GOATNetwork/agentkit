import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';
import { evmAddress } from '../../../core/schema/validators';

const inputSchema = z.object({
  chain_id: z.number().int().positive().describe('Chain ID for the callback contract'),
  spent_address: evmAddress.describe('Callback contract address'),
  spent_permit2_func_abi: z.string().min(1).describe('Permit2 function ABI signature'),
  spent_erc3009_func_abi: z.string().min(1).describe('EIP-3009 function ABI signature'),
  eip712_name: z.string().min(1).describe('EIP-712 domain name'),
  eip712_version: z.string().min(1).describe('EIP-712 domain version'),
});

export function merchantCallbackContractsSubmitAction(
  client: MerchantPortalClient,
): ActionDefinition {
  return {
    name: 'goat.x402.merchant.callback-contracts.submit',
    description: 'Submit a callback contract for admin review (owner only, DELEGATE mode)',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return client.post('/merchant/v1/callback-contracts', input, { signal: ctx.signal, accessToken: ctx.accessToken });
    },
  };
}
