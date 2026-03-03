import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';

export interface TransferNativeInput {
  to: string;
  amountWei: string;
}

export interface TransferNativeOutput {
  txHash: string;
}

const inputSchema = z.object({
  to: z.string().min(4),
  amountWei: z.string().regex(/^\d+$/),
});

export function transferNativeAction(wallet: WalletProvider): ActionDefinition<TransferNativeInput, TransferNativeOutput> {
  return {
    name: 'wallet.transfer_native',
    description: 'Transfer native token (e.g. ETH/BTC) to an address',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      return wallet.transferNative(input.to, input.amountWei);
    },
  };
}
