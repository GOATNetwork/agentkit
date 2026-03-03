import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { QUOTER_V2_ADDRESS } from '../addresses';

export interface DexQuoteInput {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amountIn: string;
}

export interface DexQuoteOutput {
  amountOut: string;
  sqrtPriceX96After: string;
  gasEstimate: string;
}

const inputSchema = z.object({
  tokenIn: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'tokenIn must be a valid address'),
  tokenOut: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'tokenOut must be a valid address'),
  fee: z.number().int().positive('fee must be a positive integer'),
  amountIn: z.string().regex(/^\d+$/, 'amountIn must be a decimal integer string'),
});

const QUOTE_ABI = [
  'function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)',
];

export function dexQuoteAction(
  wallet: WalletProvider,
): ActionDefinition<DexQuoteInput, DexQuoteOutput> {
  return {
    name: 'dex.quote',
    description: 'Get a price quote for a Uniswap V3 swap on Goat Network via OKU QuoterV2',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      const result = (await wallet.callContract(QUOTER_V2_ADDRESS, QUOTE_ABI, 'quoteExactInputSingle', [
        [input.tokenIn, input.tokenOut, BigInt(input.amountIn), input.fee, 0],
      ])) as [bigint, bigint, number, bigint];
      return {
        amountOut: String(result[0]),
        sqrtPriceX96After: String(result[1]),
        gasEstimate: String(result[3]),
      };
    },
  };
}
