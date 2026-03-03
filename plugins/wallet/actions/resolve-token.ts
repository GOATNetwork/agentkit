import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import { resolveTokenAddress } from '../../../networks/goat/tokens';

export interface ResolveTokenInput {
  symbol: string;
}

export interface ResolveTokenOutput {
  symbol: string;
  address: string;
}

const inputSchema = z.object({
  symbol: z.string().min(1),
});

export function resolveTokenAction(): ActionDefinition<ResolveTokenInput, ResolveTokenOutput> {
  return {
    name: 'wallet.resolve_token',
    description: 'Resolve a token symbol to its on-chain contract address',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      const entry = resolveTokenAddress(input.symbol);
      return { symbol: entry.symbol, address: entry.address };
    },
  };
}
