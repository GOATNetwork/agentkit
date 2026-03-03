import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { CalldataSignRequest, MerchantGatewayAdapter } from '../adapters/types';

export interface CreatePaymentInput {
  to: string;
  asset: string;
  amount: string;
  fromAddress?: string;
  expiresAt?: number;
  idempotencyKey?: string;
  callbackCalldata?: string;
}

export interface CreatePaymentOutput {
  paymentId: string;
  status: 'created';
  calldataSignRequest?: CalldataSignRequest;
}

const inputSchema = z.object({
  to: z.string().min(3),
  asset: z.string().min(2),
  amount: z.string().min(1),
  fromAddress: z.string().min(3).optional(),
  expiresAt: z.number().optional(),
  idempotencyKey: z.string().optional(),
  callbackCalldata: z.string().optional(),
});

export function createPaymentAction(merchant: MerchantGatewayAdapter): ActionDefinition<CreatePaymentInput, CreatePaymentOutput> {
  return {
    name: 'goat.x402.payment.create',
    description: 'Create x402 payment intent via merchant gateway API',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      return merchant.createPaymentIntent(input);
    },
  };
}
