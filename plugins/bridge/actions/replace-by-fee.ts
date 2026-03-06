import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { BRIDGE_ADDRESS } from './withdraw';

export interface BridgeReplaceByFeeInput {
  withdrawalId: number;
  maxTxPrice: number;
}

export interface BridgeReplaceByFeeOutput {
  txHash: string;
}

const inputSchema = z.object({
  withdrawalId: z.number().int().min(0, 'withdrawalId must be a non-negative integer'),
  maxTxPrice: z.number().int().min(0, 'maxTxPrice must be a non-negative integer'),
});

const RBF_ABI = ['function replaceByFee(uint256,uint16)'];

export function bridgeReplaceByFeeAction(
  wallet: WalletProvider,
): ActionDefinition<BridgeReplaceByFeeInput, BridgeReplaceByFeeOutput> {
  return {
    name: 'bridge.replace_by_fee',
    description: 'Replace a pending Bridge withdrawal with a higher Bitcoin transaction fee',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.writeContract(BRIDGE_ADDRESS, RBF_ABI, 'replaceByFee', [
        input.withdrawalId,
        input.maxTxPrice,
      ], undefined, { signal: ctx.signal });
    },
  };
}
