import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { PayerWalletAdapter } from '../adapters/types';
import { evmAddress } from '../../../core/schema/validators';
import { transferCheckpoints } from '../../../core/wallet/checkpoints';

export interface TransferPaymentInput {
  tokenAddress: string;
  to: string;
  amount: string;
}

export interface TransferPaymentOutput {
  txHash: string;
}

const inputSchema = z.object({
  tokenAddress: evmAddress,
  to: evmAddress,
  amount: z.string().regex(/^\d+$/),
});

export function transferPaymentAction(
  payer: PayerWalletAdapter,
): ActionDefinition<TransferPaymentInput, TransferPaymentOutput> {
  return {
    name: 'goat.x402.payment.transfer',
    description: 'Execute payer wallet token transfer to merchant payToAddress',
    riskLevel: 'high',
    requiresConfirmation: true,
    retryable: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return payer.transferToken(input, ctx.signal, transferCheckpoints(ctx));
    },
  };
}
