import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { GiftcardGateway, OrderRecord } from '../adapters/types';
import { orderRecordSchema } from './order-schema';

export interface GetOrderInput {
  orderId: string;
}

export type GetOrderOutput = OrderRecord;

const inputSchema = z
  .object({
    orderId: z.string().uuid({ message: 'orderId must be a UUID' }),
  })
  .strict();

type GatewaySlice = Pick<GiftcardGateway, 'getOrder'>;

/**
 * `sensitiveOutputFields` lists the canonical flat names per the plan.
 *
 * Caveat (documented so callers don't get surprised): the runtime's
 * redaction is SHALLOW (see `core/runtime/execution-runtime.ts:11`).
 * The backend nests delivered card data under `card.card_code`,
 * `card.card_pin`, etc. Shallow redaction therefore only zeros the
 * names below when consumers have FLATTENED the response (e.g. via
 * `mapOrder()` in `gift-fe/src/app/lib/api.ts:336`).
 *
 * To keep the canonical names in `sensitiveOutputFields` AND protect
 * the nested object too, the adapter and example flatten card.* up to
 * the top level of the returned OrderRecord before the hook runs.
 * Tests assert both paths.
 */
const SENSITIVE_OUTPUT_FIELDS = [
  'card_code',
  'card_pin',
  'card_link',
  'card_barcode',
] as const;

export function getOrderAction(gateway: GatewaySlice): ActionDefinition<GetOrderInput, GetOrderOutput> {
  return {
    name: 'goat.giftcard.getOrder',
    description: 'Fetch a giftcard order (including delivered card secrets once FULFILLED).',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: [],
    zodInputSchema: inputSchema,
    zodOutputSchema: orderRecordSchema,
    sensitiveOutputFields: [...SENSITIVE_OUTPUT_FIELDS],
    async execute(ctx, input) {
      return flattenCardFields(await gateway.getOrder(input.orderId, ctx.signal));
    },
  };
}

/**
 * Promote `card.card_code` / `card.card_pin` / etc. to the top level
 * so the runtime's SHALLOW redaction can reach them via
 * `sensitiveOutputFields`. The nested `card` object is kept intact for
 * callers that prefer the backend shape. The action's caller-visible
 * `result.output` carries the plaintext on both shapes; only the post-
 * success hook event is redacted.
 */
function flattenCardFields(order: OrderRecord): OrderRecord {
  const card = order.card;
  if (!card) return order;
  return {
    ...order,
    card_code: card.card_code ?? undefined,
    card_pin: card.card_pin ?? undefined,
    card_link: card.card_link ?? undefined,
    card_barcode: card.card_barcode ?? undefined,
  };
}
