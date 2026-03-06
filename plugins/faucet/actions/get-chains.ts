import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { FaucetAdapter } from '../adapters/types';

const inputSchema = z.object({});

export function faucetGetChainsAction(adapter: FaucetAdapter): ActionDefinition<Record<string, never>, unknown> {
  return {
    name: 'faucet.get_chains',
    description: 'List available chains supported by the Goat testnet faucet',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, _input) {
      return adapter.getChains(ctx.signal);
    },
  };
}
