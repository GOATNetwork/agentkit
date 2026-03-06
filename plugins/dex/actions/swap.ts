import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { SWAP_ROUTER_ADDRESS } from '../addresses';

export interface DexSwapInput {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amountIn: string;
  amountOutMinimum: string;
  value?: string;
}

export interface DexSwapOutput {
  txHash: string;
}

const inputSchema = z.object({
  tokenIn: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'tokenIn must be a valid address'),
  tokenOut: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'tokenOut must be a valid address'),
  fee: z.number().int().positive('fee must be a positive integer'),
  amountIn: z.string().regex(/^\d+$/, 'amountIn must be a decimal integer string'),
  amountOutMinimum: z.string().regex(/^\d+$/, 'amountOutMinimum must be a decimal integer string'),
  value: z.string().regex(/^\d+$/).optional(),
});

const SWAP_ABI = [
  'function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)',
];

export function dexSwapAction(
  wallet: WalletProvider,
): ActionDefinition<DexSwapInput, DexSwapOutput> {
  return {
    name: 'dex.swap',
    description: 'Execute a Uniswap V3 exact-input single swap on Goat Network via OKU SwapRouter02',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      const recipient = await wallet.getAddress();
      return wallet.writeContract(
        SWAP_ROUTER_ADDRESS,
        SWAP_ABI,
        'exactInputSingle',
        [[input.tokenIn, input.tokenOut, input.fee, recipient, BigInt(input.amountIn), BigInt(input.amountOutMinimum), 0]],
        input.value,
        { signal: ctx.signal },
      );
    },
  };
}
