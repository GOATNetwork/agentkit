import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { POSITION_MANAGER_ADDRESS } from '../addresses';

export interface DexGetPositionInput {
  tokenId: string;
}

export interface DexGetPositionOutput {
  tokenId: string;
  nonce: string;
  operator: string;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  feeGrowthInside0LastX128: string;
  feeGrowthInside1LastX128: string;
  tokensOwed0: string;
  tokensOwed1: string;
}

const inputSchema = z.object({
  tokenId: z.string().regex(/^\d+$/, 'tokenId must be a decimal integer string'),
});

const POSITIONS_ABI = [
  'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
];

export function dexGetPositionAction(
  wallet: WalletProvider,
): ActionDefinition<DexGetPositionInput, DexGetPositionOutput> {
  return {
    name: 'dex.get_position',
    description: 'Get details of a Uniswap V3 liquidity position on Goat Network via OKU PositionManager',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      const result = (await wallet.callContract(
        POSITION_MANAGER_ADDRESS,
        POSITIONS_ABI,
        'positions',
        [BigInt(input.tokenId)],
      )) as [bigint, string, string, string, number, number, number, bigint, bigint, bigint, bigint, bigint];
      return {
        tokenId: input.tokenId,
        nonce: String(result[0]),
        operator: result[1],
        token0: result[2],
        token1: result[3],
        fee: Number(result[4]),
        tickLower: Number(result[5]),
        tickUpper: Number(result[6]),
        liquidity: String(result[7]),
        feeGrowthInside0LastX128: String(result[8]),
        feeGrowthInside1LastX128: String(result[9]),
        tokensOwed0: String(result[10]),
        tokensOwed1: String(result[11]),
      };
    },
  };
}
