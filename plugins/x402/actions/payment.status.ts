import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantGatewayAdapter } from '../adapters/types';

export interface PaymentStatusInput {
  paymentId: string;
}

export interface PaymentStatusOutput {
  paymentId: string;
  status: 'created' | 'authorized' | 'settled' | 'failed' | 'expired';
}

const inputSchema = z.object({
  paymentId: z.string().min(3),
});

export function paymentStatusAction(
  merchant: MerchantGatewayAdapter
): ActionDefinition<PaymentStatusInput, PaymentStatusOutput> {
  return {
    name: 'goat.x402.payment.status',
    description: 'Get x402 payment status via merchant gateway API',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return merchant.getPaymentStatus(input.paymentId, ctx.signal);
    },
  };
}
