import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { getIdentityRegistryAddress } from '../addresses';

export interface GetAgentWalletInput {
  agentId: string;
}

export interface GetAgentWalletOutput {
  agentId: string;
  wallet: string;
}

const inputSchema = z.object({
  agentId: z.string().regex(/^\d+$/, 'agentId must be a numeric string'),
});

const GET_AGENT_WALLET_ABI = ['function getAgentWallet(uint256 agentId) view returns (address)'];

export function erc8004GetAgentWalletAction(
  wallet: WalletProvider,
): ActionDefinition<GetAgentWalletInput, GetAgentWalletOutput> {
  return {
    name: 'erc8004.get_agent_wallet',
    description: 'Get the linked wallet address for an agent from the ERC-8004 Identity Registry',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      const result = await wallet.callContract(
        getIdentityRegistryAddress(ctx.network),
        GET_AGENT_WALLET_ABI,
        'getAgentWallet',
        [BigInt(input.agentId)],
      );
      return { agentId: input.agentId, wallet: String(result) };
    },
  };
}
