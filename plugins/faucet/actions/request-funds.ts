import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { FaucetAdapter, FaucetResult } from '../adapters/types';

export interface RequestFundsInput {
  chain: string;
  address: string;
  tokenAddress?: string;
}

const inputSchema = z.object({
  chain: z.string().min(1),
  address: z.string().min(4),
  tokenAddress: z.string().min(4).optional(),
});

export function faucetRequestFundsAction(adapter: FaucetAdapter): ActionDefinition<RequestFundsInput, FaucetResult> {
  return {
    name: 'faucet.request_funds',
    description: 'Request testnet tokens from the Goat faucet',
    riskLevel: 'low',
    requiresConfirmation: false,
    networks: ['goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      return adapter.requestFunds(input);
    },
  };
}
