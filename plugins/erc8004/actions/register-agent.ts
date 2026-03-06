import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';

export const IDENTITY_REGISTRY_ADDRESS = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
export const REPUTATION_REGISTRY_ADDRESS = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';

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
        IDENTITY_REGISTRY_ADDRESS,
        REGISTER_ABI,
        'register',
        [input.agentURI],
        undefined,
        { signal: ctx.signal },
      );
    },
  };
}
