import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { evmAddress } from '../../../core/schema/validators';

export interface Erc721TransferInput {
  contractAddress: string;
  from: string;
  to: string;
  tokenId: string;
}

export interface Erc721TransferOutput {
  txHash: string;
}

const inputSchema = z.object({
  contractAddress: evmAddress,
  from: evmAddress,
  to: evmAddress,
  tokenId: z.string().min(1),
});

const ERC721_TRANSFER_ABI = ['function transferFrom(address from, address to, uint256 tokenId)'];

export function erc721TransferAction(wallet: WalletProvider): ActionDefinition<Erc721TransferInput, Erc721TransferOutput> {
  return {
    name: 'erc721.transfer',
    description: 'Transfer an ERC721 NFT from one address to another',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.writeContract(
        input.contractAddress,
        ERC721_TRANSFER_ABI,
        'transferFrom',
        [input.from, input.to, input.tokenId],
        undefined,
        { signal: ctx.signal },
      );
    },
  };
}
