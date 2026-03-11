import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantGatewayAdapter } from '../adapters/types';

export interface CancelPaymentInput {
  paymentId: string;
}

export interface CancelPaymentOutput {
  paymentId: string;
  status: 'cancelled' | 'failed';
}

const inputSchema = z.object({
  paymentId: z.string().min(3),
});

export function cancelPaymentAction(
  merchant: MerchantGatewayAdapter
): ActionDefinition<CancelPaymentInput, CancelPaymentOutput> {
  return {
    name: 'goat.x402.payment.cancel',
    description: 'Cancel x402 payment via merchant gateway API',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return merchant.cancelPayment(input.paymentId, ctx.signal);
    },
  };
}
