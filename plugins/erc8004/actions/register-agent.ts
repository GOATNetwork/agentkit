import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { getIdentityRegistryAddress } from '../addresses';

export interface RegisterAgentInput {
  agentURI: string;
}

export interface RegisterAgentOutput {
  txHash: string;
}

const inputSchema = z.object({
  agentURI: z.string().min(1, 'agentURI must not be empty'),
});

const REGISTER_ABI = ['function register(string agentURI) returns (uint256 agentId)'];

export function erc8004RegisterAgentAction(
  wallet: WalletProvider,
): ActionDefinition<RegisterAgentInput, RegisterAgentOutput> {
  return {
    name: 'erc8004.register_agent',
    description: 'Register a new agent in the ERC-8004 Identity Registry. Returns the transaction hash. The agentURI should point to a JSON registration file describing the agent.',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.writeContract(
        getIdentityRegistryAddress(ctx.network),
        REGISTER_ABI,
        'register',
        [input.agentURI],
        undefined,
        { signal: ctx.signal },
      );
    },
  };
}
