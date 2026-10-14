import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { evmAddress } from '../../../core/schema/validators';
import { transferCheckpoints } from '../../../core/wallet/checkpoints';

export interface TransferNativeInput {
  to: string;
  amountWei: string;
}

export interface TransferNativeOutput {
  txHash: string;
}

const inputSchema = z.object({
  to: evmAddress,
  amountWei: z.string().regex(/^\d+$/),
});

export function transferNativeAction(
  wallet: WalletProvider,
): ActionDefinition<TransferNativeInput, TransferNativeOutput> {
  return {
    name: 'wallet.transfer_native',
    description: 'Transfer native token (e.g. ETH/BTC) to an address',
    riskLevel: 'high',
    requiresConfirmation: true,
    retryable: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.transferNative(input.to, input.amountWei, transferCheckpoints(ctx));
    },
  };
}
