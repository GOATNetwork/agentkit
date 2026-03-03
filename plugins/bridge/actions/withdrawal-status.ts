import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { BRIDGE_ADDRESS } from './withdraw';

export interface BridgeWithdrawalStatusInput {
  withdrawalId: number;
}

export interface BridgeWithdrawalStatusOutput {
  withdrawalId: number;
  sender: string;
  maxTxPrice: number;
  status: number;
  amount: string;
  tax: string;
  updatedAt: string;
}

const inputSchema = z.object({
  withdrawalId: z.number().int().min(0, 'withdrawalId must be a non-negative integer'),
});

const WITHDRAWALS_ABI = [
  'function withdrawals(uint256) view returns (address,uint16,uint8,uint256,uint256,uint256)',
];

export function bridgeWithdrawalStatusAction(
  wallet: WalletProvider,
): ActionDefinition<BridgeWithdrawalStatusInput, BridgeWithdrawalStatusOutput> {
  return {
    name: 'bridge.withdrawal_status',
    description: 'Query the status of a Bridge withdrawal by its ID',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      const result = await wallet.callContract(
        BRIDGE_ADDRESS,
        WITHDRAWALS_ABI,
        'withdrawals',
        [input.withdrawalId],
      );
      const tuple = result as [string, number, number, bigint, bigint, bigint];
      return {
        withdrawalId: input.withdrawalId,
        sender: tuple[0],
        maxTxPrice: Number(tuple[1]),
        status: Number(tuple[2]),
        amount: String(tuple[3]),
        tax: String(tuple[4]),
        updatedAt: String(tuple[5]),
      };
    },
  };
}
