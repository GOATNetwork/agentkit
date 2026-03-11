import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { FaucetAdapter, FaucetResult } from '../adapters/types';
import { evmAddress } from '../../../core/schema/validators';

export interface RequestFundsInput {
  chain: string;
  address: string;
  tokenAddress?: string;
}

const inputSchema = z.object({
  chain: z.string().min(1),
  address: evmAddress,
  tokenAddress: evmAddress.optional(),
});

export function faucetRequestFundsAction(adapter: FaucetAdapter): ActionDefinition<RequestFundsInput, FaucetResult> {
  return {
    name: 'faucet.request_funds',
    description: 'Request testnet tokens from the Goat faucet',
    riskLevel: 'low',
    requiresConfirmation: false,
    networks: ['goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return adapter.requestFunds(input, ctx.signal);
    },
  };
}
