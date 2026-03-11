import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { POSITION_MANAGER_ADDRESS } from '../addresses';

export interface DexAddLiquidityInput {
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: string;
  amount1Desired: string;
  amount0Min: string;
  amount1Min: string;
  deadline: string;
  value?: string;
}

export interface DexAddLiquidityOutput {
  txHash: string;
}

const inputSchema = z.object({
  token0: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'token0 must be a valid address'),
  token1: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'token1 must be a valid address'),
  fee: z.number().int().positive('fee must be a positive integer'),
  tickLower: z.number().int(),
  tickUpper: z.number().int(),
  amount0Desired: z.string().regex(/^\d+$/, 'amount0Desired must be a decimal integer string'),
  amount1Desired: z.string().regex(/^\d+$/, 'amount1Desired must be a decimal integer string'),
  amount0Min: z.string().regex(/^\d+$/, 'amount0Min must be a decimal integer string'),
  amount1Min: z.string().regex(/^\d+$/, 'amount1Min must be a decimal integer string'),
  deadline: z.string().regex(/^\d+$/, 'deadline must be a decimal integer string'),
  value: z.string().regex(/^\d+$/).optional(),
});

const MINT_ABI = [
  'function mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256)) payable returns (uint256,uint128,uint256,uint256)',
];

export function dexAddLiquidityAction(
  wallet: WalletProvider,
): ActionDefinition<DexAddLiquidityInput, DexAddLiquidityOutput> {
  return {
    name: 'dex.add_liquidity',
    description: 'Add liquidity to a Uniswap V3 pool on Goat Network via OKU PositionManager',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      const recipient = await wallet.getAddress();
      return wallet.writeContract(
        POSITION_MANAGER_ADDRESS,
        MINT_ABI,
        'mint',
        [[
          input.token0,
          input.token1,
          input.fee,
          input.tickLower,
          input.tickUpper,
          BigInt(input.amount0Desired),
          BigInt(input.amount1Desired),
          BigInt(input.amount0Min),
          BigInt(input.amount1Min),
          recipient,
          BigInt(input.deadline),
        ]],
        input.value,
        { signal: ctx.signal },
      );
    },
  };
}
