import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { evmAddress } from '../../../core/schema/validators';

export interface Erc721MintInput {
  contractAddress: string;
  to: string;
  tokenId: string;
}

export interface Erc721MintOutput {
  txHash: string;
}

const inputSchema = z.object({
  contractAddress: evmAddress,
  to: evmAddress,
  tokenId: z.string().min(1),
});

const ERC721_MINT_ABI = ['function mint(address to, uint256 tokenId)'];

export function erc721MintAction(wallet: WalletProvider): ActionDefinition<Erc721MintInput, Erc721MintOutput> {
  return {
    name: 'erc721.mint',
    description: 'Mint a new ERC721 NFT to an address',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.writeContract(
        input.contractAddress,
        ERC721_MINT_ABI,
        'mint',
        [input.to, input.tokenId],
        undefined,
        { signal: ctx.signal },
      );
    },
  };
}
