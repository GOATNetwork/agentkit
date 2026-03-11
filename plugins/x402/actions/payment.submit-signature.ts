import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { CalldataSignRequest, MerchantGatewayAdapter, PayerWalletAdapter } from '../adapters/types';

export interface SubmitSignatureInput {
  paymentId: string;
  signature?: string;
  calldataSignRequest?: CalldataSignRequest;
}

export interface SubmitSignatureOutput {
  paymentId: string;
  status: 'authorized' | 'failed';
}

const signReqSchema = z.object({
  domain: z.record(z.any()),
  types: z.record(z.array(z.object({ name: z.string(), type: z.string() }))),
  primaryType: z.string().min(1),
  message: z.record(z.any()),
});

const inputSchema = z
  .object({
    paymentId: z.string().min(3),
    signature: z.string().min(3).optional(),
    calldataSignRequest: signReqSchema.optional(),
  })
  .refine((v) => Boolean(v.signature || v.calldataSignRequest), {
    message: 'signature or calldataSignRequest is required',
    path: ['signature'],
  });

export function submitSignatureAction(
  merchant: MerchantGatewayAdapter,
  payer: PayerWalletAdapter
): ActionDefinition<SubmitSignatureInput, SubmitSignatureOutput> {
  return {
    name: 'goat.x402.payment.submitSignature',
    description: 'Submit payer signature to merchant gateway (supports EIP-712 signing)',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      const sig = input.calldataSignRequest
        ? await payer.signCalldataTypedData(input.calldataSignRequest)
        : await payer.normalizeAuthorization(input.signature!);

      return merchant.submitPaymentAuthorization(input.paymentId, sig, ctx.signal);
    },
  };
}
