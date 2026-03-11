import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';

export const BITCOIN_ADDRESS = '0xbC10000000000000000000000000000000000005';

export interface BitcoinBlockHashInput {
  height: number;
}

export interface BitcoinBlockHashOutput {
  height: number;
  blockHash: string;
}

const inputSchema = z.object({
  height: z.number().int().min(0, 'height must be a non-negative integer'),
});

const BLOCK_HASH_ABI = ['function blockHash(uint256) view returns (bytes32)'];

export function bitcoinBlockHashAction(
  wallet: WalletProvider,
): ActionDefinition<BitcoinBlockHashInput, BitcoinBlockHashOutput> {
  return {
    name: 'bitcoin.block_hash',
    description: 'Get the Bitcoin block hash at a given height from the on-chain oracle',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      const blockHash = await wallet.callContract(
        BITCOIN_ADDRESS,
        BLOCK_HASH_ABI,
        'blockHash',
        [input.height],
      );
      return { height: input.height, blockHash: String(blockHash) };
    },
  };
}
