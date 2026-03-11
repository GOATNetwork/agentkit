import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';

export const BRIDGE_ADDRESS = '0xBC10000000000000000000000000000000000003';

export interface BridgeWithdrawInput {
  receiver: string;
  amountWei: string;
  maxTxPrice: number;
}

export interface BridgeWithdrawOutput {
  txHash: string;
}

const inputSchema = z.object({
  receiver: z.string().min(1, 'receiver must be a Bitcoin address'),
  amountWei: z.string().regex(/^\d+$/, 'amountWei must be a decimal integer string'),
  maxTxPrice: z.number().int().min(0, 'maxTxPrice must be a non-negative integer'),
});

const WITHDRAW_ABI = ['function withdraw(string,uint16) payable'];

export function bridgeWithdrawAction(
  wallet: WalletProvider,
): ActionDefinition<BridgeWithdrawInput, BridgeWithdrawOutput> {
  return {
    name: 'bridge.withdraw',
    description: 'Withdraw BTC from Goat Network to a Bitcoin address via the Bridge contract',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.writeContract(
        BRIDGE_ADDRESS,
        WITHDRAW_ABI,
        'withdraw',
        [input.receiver, input.maxTxPrice],
        input.amountWei,
        { signal: ctx.signal },
      );
    },
  };
}
