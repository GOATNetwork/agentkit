import { z } from 'zod';
import type { ActionDefinition } from '../../core/schema/action';
import type { PaykitService } from './service';
import { paymentFingerprintPattern } from './recovery';
import { evmAddress, positiveUint256 } from '../../core/schema/validators';

const url = z.string().trim().url();
const key = z.string().trim().min(1).max(200).optional();
const positiveAmount = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d+)?$/)
  .refine((s) => /[1-9]/.test(s), 'Amount must be positive');
const payment = z.object({
  url,
  chainId: z.number().int().positive().safe(),
  tokenContract: evmAddress.optional(),
  tokenSymbol: z.string().trim().min(1).optional(),
  idempotencyKey: key,
  pollTimeoutMs: z.number().int().min(1).max(300_000).optional(),
  pollIntervalMs: z.number().int().min(1).max(30_000).optional(),
});
const tokenSelected = (v: { tokenContract?: string; tokenSymbol?: string }) => !!(v.tokenContract || v.tokenSymbol);
const payInput = payment
  .extend({ amount: positiveAmount, memo: z.string().max(256).optional() })
  .strict()
  .refine(tokenSelected, 'Select a token');
const productInput = payment
  .extend({
    productKey: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._:~-]{1,64}$/),
  })
  .strict()
  .refine(tokenSelected, 'Select a token');
const mppInput = z
  .object({
    url,
    route: z.string().min(1),
    idempotencyKey: key,
    maxAmountWei: positiveUint256.optional(),
    maxVerifyAttempts: z.number().int().min(1).max(16).optional(),
  })
  .strict();
const cardInput = z
  .object({
    url,
    idempotencyKey: key,
    productKey: z.string().min(1).optional(),
    amount: positiveAmount.optional(),
    memo: z.string().max(256).optional(),
  })
  .strict()
  .refine((v) => !!v.productKey !== !!v.amount, 'Provide exactly one of productKey or amount');
const statusInput = z
  .object({
    url,
    sessionId: z.string().min(1).optional(),
    operationId: z.string().min(1).optional(),
    expectedFingerprint: z.string().regex(paymentFingerprintPattern).optional(),
  })
  .strict()
  .refine((v) => !!v.sessionId || !!v.operationId, 'Provide sessionId or operationId')
  .refine((v) => !v.expectedFingerprint || !!v.operationId, 'An expected fingerprint requires an operationId');
const resumeInput = z
  .object({
    url,
    operationId: z.string().min(1),
    expectedFingerprint: z.string().regex(paymentFingerprintPattern).optional(),
    maxVerifyAttempts: z.number().int().min(1).max(16).optional(),
  })
  .strict();

export const paykitSensitiveOutputFields = [
  'session_id',
  'checkout_id',
  'sessionId',
  'url',
  'receiptHeader',
  'receiptBody',
  'receipt_header',
  'receipt',
];
const write = {
  riskLevel: 'high' as const,
  requiresConfirmation: true,
  retryable: false,
  idempotencyMode: 'action' as const,
  networks: [],
  sensitiveOutputFields: paykitSensitiveOutputFields,
};
const read = { riskLevel: 'read' as const, requiresConfirmation: false, networks: [] };

const inspectInput = z.object({ url }).strict();

/** Shared validation and confirmation metadata, available without constructing a service. */
export const paykitActionDefinitions = {
  inspect: { ...read, name: 'goat.paykit.inspect', zodInputSchema: inspectInput },
  pay: { ...write, name: 'goat.paykit.pay', zodInputSchema: payInput },
  payProduct: { ...write, name: 'goat.paykit.payProduct', zodInputSchema: productInput },
  sessionStatus: {
    ...read,
    name: 'goat.paykit.sessionStatus',
    zodInputSchema: statusInput,
    riskLevel: 'recovery' as const,
    retryable: false,
  },
  payMpp: { ...write, name: 'goat.paykit.payMpp', zodInputSchema: mppInput },
  resumeMpp: {
    ...read,
    name: 'goat.paykit.resumeMpp',
    zodInputSchema: resumeInput,
    riskLevel: 'recovery' as const,
    retryable: false,
  },
  createCardCheckout: {
    ...write,
    name: 'goat.paykit.createCardCheckout',
    zodInputSchema: cardInput,
    riskLevel: 'medium' as const,
  },
};

export function paykitInspectAction(
  service: PaykitService,
): ActionDefinition<z.infer<typeof inspectInput>, Awaited<ReturnType<PaykitService['inspect']>>> {
  return {
    ...paykitActionDefinitions.inspect,
    description: 'Discover PayKit merchant tokens, products and enabled payment rails',
    execute: (ctx, input) => service.inspect(input.url, ctx),
  };
}

export function paykitPayAction(
  service: PaykitService,
): ActionDefinition<z.infer<typeof payInput>, Awaited<ReturnType<PaykitService['pay']>>> {
  return {
    ...paykitActionDefinitions.pay,
    description: 'Pay a custom crypto amount; requires a stable idempotency key and a real broadcast-capable wallet',
    execute: (ctx, input) => service.pay(input, ctx),
  };
}
export function paykitPayProductAction(
  service: PaykitService,
): ActionDefinition<z.infer<typeof productInput>, Awaited<ReturnType<PaykitService['pay']>>> {
  return {
    ...paykitActionDefinitions.payProduct,
    description: 'Pay for a merchant product after validating its quoted price and selected token',
    execute: (ctx, input) => service.pay(input, ctx),
  };
}
export function paykitSessionStatusAction(
  service: PaykitService,
): ActionDefinition<z.infer<typeof statusInput>, Awaited<ReturnType<PaykitService['sessionStatus']>>> {
  return {
    ...paykitActionDefinitions.sessionStatus,
    // Resolving an operation without a session ID can replay a creation POST.
    description: 'Inspect an existing PayKit payment without sending again',
    sensitiveInputFields: ['sessionId'],
    sensitiveOutputFields: paykitSensitiveOutputFields,
    execute: (ctx, input) => service.sessionStatus(input, ctx),
  };
}
export function paykitPayMppAction(
  service: PaykitService,
): ActionDefinition<z.infer<typeof mppInput>, Awaited<ReturnType<PaykitService['payMpp']>>> {
  return {
    ...paykitActionDefinitions.payMpp,
    description: 'Pay a GOAT Flow MPP route and obtain its Payment-Receipt; requires an ethers signer',
    execute: (ctx, input) => service.payMpp(input, ctx),
  };
}
export function paykitResumeMppAction(
  service: PaykitService,
): ActionDefinition<z.infer<typeof resumeInput>, Awaited<ReturnType<PaykitService['resumeMpp']>>> {
  return {
    ...paykitActionDefinitions.resumeMpp,
    description: 'Resume GOAT Flow MPP receipt verification from the journal; never sends another transfer',
    sensitiveOutputFields: paykitSensitiveOutputFields,
    execute: (ctx, input) => service.resumeMpp(input, ctx),
  };
}
export function paykitCreateCardCheckoutAction(
  service: PaykitService,
): ActionDefinition<z.infer<typeof cardInput>, Awaited<ReturnType<PaykitService['createCardCheckout']>>> {
  return {
    ...paykitActionDefinitions.createCardCheckout,
    description: 'Create a hosted card checkout link for a human to complete; does not confirm payment',
    execute: (ctx, input) => service.createCardCheckout(input, ctx),
  };
}

export function createPaykitActions(service: PaykitService): ActionDefinition[] {
  return [
    paykitInspectAction(service),
    paykitPayAction(service),
    paykitPayProductAction(service),
    paykitSessionStatusAction(service),
    paykitPayMppAction(service),
    paykitResumeMppAction(service),
    paykitCreateCardCheckoutAction(service),
  ] as ActionDefinition[];
}
