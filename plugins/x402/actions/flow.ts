import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import { GoatFlowGatewayAdapter, flowCreateOrderSchema, flowCheckoutSchema } from '../adapters/goat-flow-gateway';

export function flowCreateOrderAction(adapter: GoatFlowGatewayAdapter): ActionDefinition {
  return {
    name: 'goat.x402.order.create',
    description:
      'Create an authenticated GOAT Flow native order; dappOrderId is unique and ambiguous failures require reconciliation',
    riskLevel: 'medium',
    requiresConfirmation: true,
    retryable: false,
    idempotencyMode: 'action',
    networks: [],
    zodInputSchema: flowCreateOrderSchema,
    execute: (ctx, input) =>
      adapter.createOrderFromParsedInput(input as z.output<typeof flowCreateOrderSchema>, ctx.signal, ctx),
  };
}

export function flowCreateCheckoutAction(adapter: GoatFlowGatewayAdapter): ActionDefinition {
  return {
    name: 'goat.x402.checkout.create',
    description: 'Create an authenticated hosted checkout session with pinned prices and crypto/fiat rails',
    riskLevel: 'medium',
    requiresConfirmation: true,
    retryable: false,
    idempotencyMode: 'action',
    networks: [],
    sensitiveInputFields: ['privateMetadata'],
    sensitiveOutputFields: ['checkoutId', 'url'],
    zodInputSchema: flowCheckoutSchema,
    execute: (ctx, input) =>
      adapter.createCheckoutFromParsedInput(input as z.output<typeof flowCheckoutSchema>, ctx.signal, ctx),
  };
}

export function paymentProofAction(adapter: GoatFlowGatewayAdapter): ActionDefinition {
  const schema = z.object({ paymentId: z.string().min(1) }).strict();
  return {
    name: 'goat.x402.payment.proof',
    description: 'Get the server payment record; its checksum is not a cryptographic attestation',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: [],
    zodInputSchema: schema,
    execute: (ctx, input) => adapter.getPaymentProof((input as z.output<typeof schema>).paymentId, ctx.signal),
  };
}
