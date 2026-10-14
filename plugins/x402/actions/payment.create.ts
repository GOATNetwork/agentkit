import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { CalldataSignRequest, MerchantGatewayAdapter } from '../adapters/types';
import { AgentkitRuntimeError } from '../../../core/errors/error';
import { ErrorCodes } from '../../../core/errors/error-codes';
import { evmAddress } from '../../../core/schema/validators';

export interface CreatePaymentInput {
  to: string;
  asset: string;
  amount: string;
  chainId?: number;
  tokenContract?: string;
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
  to: evmAddress,
  asset: z.string().min(2),
  amount: z.string().min(1),
  chainId: z.number().int().positive().safe().optional(),
  tokenContract: evmAddress.optional(),
  fromAddress: evmAddress.optional(),
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
    retryable: false,
    idempotencyMode: merchant.managesIdempotency ? 'action' : 'runtime',
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      if (input.idempotencyKey && ctx.idempotencyKey && input.idempotencyKey !== ctx.idempotencyKey) {
        throw new AgentkitRuntimeError(ErrorCodes.INVALID_INPUT, 'Conflicting idempotency keys');
      }
      return merchant.createPaymentIntent({ ...input, idempotencyKey: input.idempotencyKey ?? ctx.idempotencyKey }, ctx.signal, ctx);
    },
  };
}
