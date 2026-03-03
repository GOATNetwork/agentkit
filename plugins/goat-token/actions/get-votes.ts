import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { GOAT_TOKEN_ADDRESS } from './delegate';

export interface GoatTokenGetVotesInput {
  address: string;
}

export interface GoatTokenGetVotesOutput {
  address: string;
  votes: string;
}

const inputSchema = z.object({
  address: z.string().min(4, 'address must be a valid address'),
});

const GET_VOTES_ABI = ['function getVotes(address) view returns (uint256)'];

export function goatTokenGetVotesAction(
  wallet: WalletProvider,
): ActionDefinition<GoatTokenGetVotesInput, GoatTokenGetVotesOutput> {
  return {
    name: 'goat_token.get_votes',
    description: 'Get the current voting power of an address for the GOAT governance token',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      const votes = await wallet.callContract(GOAT_TOKEN_ADDRESS, GET_VOTES_ABI, 'getVotes', [
        input.address,
      ]);
      return { address: input.address, votes: String(votes) };
    },
  };
}
