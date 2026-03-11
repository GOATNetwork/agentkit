import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { POSITION_MANAGER_ADDRESS } from '../addresses';

export interface DexRemoveLiquidityInput {
  tokenId: string;
  liquidity: string;
  amount0Min: string;
  amount1Min: string;
  deadline: string;
}

export interface DexRemoveLiquidityOutput {
  txHash: string;
}

const inputSchema = z.object({
  tokenId: z.string().regex(/^\d+$/, 'tokenId must be a decimal integer string'),
  liquidity: z.string().regex(/^\d+$/, 'liquidity must be a decimal integer string'),
  amount0Min: z.string().regex(/^\d+$/, 'amount0Min must be a decimal integer string'),
  amount1Min: z.string().regex(/^\d+$/, 'amount1Min must be a decimal integer string'),
  deadline: z.string().regex(/^\d+$/, 'deadline must be a decimal integer string'),
});

const DECREASE_LIQUIDITY_ABI = [
  'function decreaseLiquidity((uint256,uint128,uint256,uint256,uint256)) returns (uint256,uint256)',
];

export function dexRemoveLiquidityAction(
  wallet: WalletProvider,
): ActionDefinition<DexRemoveLiquidityInput, DexRemoveLiquidityOutput> {
  return {
    name: 'dex.remove_liquidity',
    description: 'Remove liquidity from a Uniswap V3 position on Goat Network via OKU PositionManager',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.writeContract(
        POSITION_MANAGER_ADDRESS,
        DECREASE_LIQUIDITY_ABI,
        'decreaseLiquidity',
        [[
          BigInt(input.tokenId),
          BigInt(input.liquidity),
          BigInt(input.amount0Min),
          BigInt(input.amount1Min),
          BigInt(input.deadline),
        ]],
        undefined,
        { signal: ctx.signal },
      );
    },
  };
}
