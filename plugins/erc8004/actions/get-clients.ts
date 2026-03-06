import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { REPUTATION_REGISTRY_ADDRESS } from './register-agent';

export interface GetClientsInput {
  agentId: string;
}

export interface GetClientsOutput {
  agentId: string;
  clients: string[];
}

const inputSchema = z.object({
  agentId: z.string().regex(/^\d+$/, 'agentId must be a numeric string'),
});

const GET_CLIENTS_ABI = ['function getClients(uint256 agentId) view returns (address[])'];

export function erc8004GetClientsAction(
  wallet: WalletProvider,
): ActionDefinition<GetClientsInput, GetClientsOutput> {
  return {
    name: 'erc8004.get_clients',
    description: 'Get the list of client addresses that have submitted feedback for an agent in the ERC-8004 Reputation Registry',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      const result = await wallet.callContract(
        REPUTATION_REGISTRY_ADDRESS,
        GET_CLIENTS_ABI,
        'getClients',
        [BigInt(input.agentId)],
      );
      return {
        agentId: input.agentId,
        clients: (result as string[]).map(String),
      };
    },
  };
}
