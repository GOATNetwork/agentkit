import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { BRIDGE_ADDRESS } from './withdraw';

export interface BridgeCancelInput {
  withdrawalId: number;
}

export interface BridgeCancelOutput {
  txHash: string;
}

const inputSchema = z.object({
  withdrawalId: z.number().int().min(0, 'withdrawalId must be a non-negative integer'),
});

const CANCEL_ABI = ['function cancel1(uint256)'];

export function bridgeCancelAction(
  wallet: WalletProvider,
): ActionDefinition<BridgeCancelInput, BridgeCancelOutput> {
  return {
    name: 'bridge.cancel',
    description: 'Cancel a pending Bridge withdrawal by its ID',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.writeContract(BRIDGE_ADDRESS, CANCEL_ABI, 'cancel1', [input.withdrawalId], undefined, { signal: ctx.signal });
    },
  };
}
