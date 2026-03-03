import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { PayerWalletAdapter } from '../adapters/types';

export interface TransferPaymentInput {
  tokenAddress: string;
  to: string;
  amount: string;
}

export interface TransferPaymentOutput {
  txHash: string;
}

const inputSchema = z.object({
  tokenAddress: z.string().min(4),
  to: z.string().min(4),
  amount: z.string().regex(/^\d+$/),
});

export function transferPaymentAction(
  payer: PayerWalletAdapter
): ActionDefinition<TransferPaymentInput, TransferPaymentOutput> {
  return {
    name: 'goat.x402.payment.transfer',
    description: 'Execute payer wallet token transfer to merchant payToAddress',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      return payer.transferToken(input);
    },
  };
}
