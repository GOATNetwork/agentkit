import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { POSITION_MANAGER_ADDRESS } from '../addresses';

export interface DexCollectFeesInput {
  tokenId: string;
  amount0Max: string;
  amount1Max: string;
}

export interface DexCollectFeesOutput {
  txHash: string;
}

const inputSchema = z.object({
  tokenId: z.string().regex(/^\d+$/, 'tokenId must be a decimal integer string'),
  amount0Max: z.string().regex(/^\d+$/, 'amount0Max must be a decimal integer string'),
  amount1Max: z.string().regex(/^\d+$/, 'amount1Max must be a decimal integer string'),
});

const COLLECT_ABI = [
  'function collect((uint256,address,uint128,uint128)) returns (uint256,uint256)',
];

export function dexCollectFeesAction(
  wallet: WalletProvider,
): ActionDefinition<DexCollectFeesInput, DexCollectFeesOutput> {
  return {
    name: 'dex.collect_fees',
    description: 'Collect accumulated fees from a Uniswap V3 position on Goat Network via OKU PositionManager',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      const recipient = await wallet.getAddress();
      return wallet.writeContract(
        POSITION_MANAGER_ADDRESS,
        COLLECT_ABI,
        'collect',
        [[BigInt(input.tokenId), recipient, BigInt(input.amount0Max), BigInt(input.amount1Max)]],
        undefined,
        { signal: ctx.signal },
      );
    },
  };
}
