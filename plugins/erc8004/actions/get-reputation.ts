import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { REPUTATION_REGISTRY_ADDRESS } from './register-agent';
import { evmAddress } from '../../../core/schema/validators';

export interface GetReputationInput {
  agentId: string;
  clientAddresses: string[];
  tag1: string;
  tag2: string;
}

export interface GetReputationOutput {
  agentId: string;
  count: string;
  summaryValue: string;
  summaryValueDecimals: number;
}

const inputSchema = z.object({
  agentId: z.string().regex(/^\d+$/, 'agentId must be a numeric string'),
  clientAddresses: z.array(evmAddress),
  tag1: z.string(),
  tag2: z.string(),
});

const GET_SUMMARY_ABI = [
  'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)',
];

export function erc8004GetReputationAction(
  wallet: WalletProvider,
): ActionDefinition<GetReputationInput, GetReputationOutput> {
  return {
    name: 'erc8004.get_reputation',
    description: 'Get the reputation summary for an agent from the ERC-8004 Reputation Registry. Filter by client addresses and tags. Pass empty arrays/strings for no filter.',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      const result = await wallet.callContract(
        REPUTATION_REGISTRY_ADDRESS,
        GET_SUMMARY_ABI,
        'getSummary',
        [BigInt(input.agentId), input.clientAddresses, input.tag1, input.tag2],
      ) as any[];
      return {
        agentId: input.agentId,
        count: String(result[0]),
        summaryValue: String(result[1]),
        summaryValueDecimals: Number(result[2]),
      };
    },
  };
}
