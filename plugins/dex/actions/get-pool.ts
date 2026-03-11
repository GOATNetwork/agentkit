import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { V3_FACTORY_ADDRESS } from '../addresses';

export interface DexGetPoolInput {
  tokenA: string;
  tokenB: string;
  fee: number;
}

export interface DexGetPoolOutput {
  pool: string;
}

const inputSchema = z.object({
  tokenA: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'tokenA must be a valid address'),
  tokenB: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'tokenB must be a valid address'),
  fee: z.number().int().positive('fee must be a positive integer'),
});

const GET_POOL_ABI = ['function getPool(address,address,uint24) view returns (address)'];

export function dexGetPoolAction(
  wallet: WalletProvider,
): ActionDefinition<DexGetPoolInput, DexGetPoolOutput> {
  return {
    name: 'dex.get_pool',
    description: 'Look up a Uniswap V3 pool address on Goat Network via OKU V3Factory',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      const pool = await wallet.callContract(
        V3_FACTORY_ADDRESS,
        GET_POOL_ABI,
        'getPool',
        [input.tokenA, input.tokenB, input.fee],
      );
      return { pool: String(pool) };
    },
  };
}
