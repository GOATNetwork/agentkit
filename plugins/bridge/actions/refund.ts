import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { BRIDGE_ADDRESS } from './withdraw';

export interface BridgeRefundInput {
  withdrawalId: number;
}

export interface BridgeRefundOutput {
  txHash: string;
}

const inputSchema = z.object({
  withdrawalId: z.number().int().min(0, 'withdrawalId must be a non-negative integer'),
});

const REFUND_ABI = ['function refund(uint256)'];

export function bridgeRefundAction(
  wallet: WalletProvider,
): ActionDefinition<BridgeRefundInput, BridgeRefundOutput> {
  return {
    name: 'bridge.refund',
    description: 'Refund a cancelled Bridge withdrawal by its ID',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.writeContract(BRIDGE_ADDRESS, REFUND_ABI, 'refund', [input.withdrawalId], undefined, { signal: ctx.signal });
    },
  };
}
