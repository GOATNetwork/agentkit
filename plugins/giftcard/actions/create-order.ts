import { z } from 'zod';
import { AgentkitRuntimeError } from '../../../core/errors/error';
import { ErrorCodes } from '../../../core/errors/error-codes';
import type { ActionDefinition } from '../../../core/schema/action';
import type { GiftcardGateway, OrderRecord } from '../adapters/types';
import { orderRecordSchema } from './order-schema';
import { ORDER_SENSITIVE_FIELDS, flattenCardFields } from './order-utils';

export interface CreateOrderActionInput {
  product_id: string;
  face_value: number;
  pay_chain_id: number;
  pay_token_symbol: 'USDC' | 'USDT';
  /**
   * Caller-supplied idempotency key. MUST be identical to the
   * `ExecutionOptions.idempotencyKey` passed to
   * `ExecutionRuntime.run(...)`; otherwise the action rejects with
   * INVALID_INPUT before any HTTP traffic. Same-key everywhere lets
   * the runtime cache short-circuit retries AND lets the backend
   * deduplicate concurrent submissions.
   */
  idempotency_key: string;
}

export type CreateOrderActionOutput = OrderRecord;

const inputSchema = z
  .object({
    product_id: z.string().uuid({ message: 'product_id must be a UUID' }),
    face_value: z.number().positive(),
    pay_chain_id: z.number().int().positive(),
    pay_token_symbol: z.union([z.literal('USDC'), z.literal('USDT')]),
    idempotency_key: z
      .string()
      .min(16, 'idempotency_key must be at least 16 chars (recommend a UUID)')
      .max(128),
  })
  .strict();

type GatewaySlice = Pick<GiftcardGateway, 'createOrder'>;

/**
 * `goat.giftcard.createOrder` — creates an off-chain payment intent.
 *
 * Risk model:
 *   - `medium`: no on-chain spend yet. The actual ERC-20 transfer
 *     happens in `goat.giftcard.payOrder`.
 *   - `requiresConfirmation`: pricing (face value × markup) and the
 *     pay-to-address are returned by the backend; surface the order to
 *     the user before they sign.
 *
 * `networks: []` (wildcard at the action level). The auth signer's
 * EIP-712 domain uses `chainId: 2345` regardless of the wallet's
 * currently-connected chain — see the plan's "auth chain vs payment
 * chain" note. PolicyEngine's `allowedNetworks` still gates which
 * runtime contexts may invoke this action.
 */
export function createOrderAction(
  gateway: GatewaySlice,
): ActionDefinition<CreateOrderActionInput, CreateOrderActionOutput> {
  return {
    name: 'goat.giftcard.createOrder',
    description:
      'Create a giftcard purchase order (off-chain payment intent). Returns pay-to address, token contract, and pay amount.',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: [],
    zodInputSchema: inputSchema,
    zodOutputSchema: orderRecordSchema,
    // Same-as-get/listOrders: if backend idempotency replays a fulfilled
    // order for an already-seen key, the response can carry card_code /
    // card_pin / etc. Declare them sensitive so hook events are redacted
    // and flatten the nested `card` so shallow redaction reaches them.
    sensitiveOutputFields: [...ORDER_SENSITIVE_FIELDS],
    async execute(ctx, input) {
      // Idempotency contract: when the caller supplies a runtime
      // idempotencyKey via ExecutionOptions, it MUST equal the action
      // input's idempotency_key. Mismatch means the caller would
      // otherwise rotate the runtime cache key without rotating the
      // backend key (or vice versa), which would let a stale/duplicate
      // order escape dedup. Reject up-front before any HTTP traffic.
      if (ctx.idempotencyKey != null && ctx.idempotencyKey !== input.idempotency_key) {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          'idempotency key mismatch: ctx vs input',
        );
      }
      return flattenCardFields(await gateway.createOrder(input, ctx.signal));
    },
  };
}
