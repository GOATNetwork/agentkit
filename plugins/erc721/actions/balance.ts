import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { evmAddress } from '../../../core/schema/validators';

export interface Erc721BalanceInput {
  contractAddress: string;
  owner: string;
}

export interface Erc721BalanceOutput {
  contractAddress: string;
  owner: string;
  balance: string;
}

const inputSchema = z.object({
  contractAddress: evmAddress,
  owner: evmAddress,
});

const ERC721_BALANCE_ABI = ['function balanceOf(address owner) view returns (uint256)'];

export function erc721BalanceAction(wallet: WalletProvider): ActionDefinition<Erc721BalanceInput, Erc721BalanceOutput> {
  return {
    name: 'erc721.balance',
    description: 'Query ERC721 NFT balance for an address',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      const result = await wallet.callContract(
        input.contractAddress,
        ERC721_BALANCE_ABI,
        'balanceOf',
        [input.owner],
      );
      return {
        contractAddress: input.contractAddress,
        owner: input.owner,
        balance: String(result),
      };
    },
  };
}
