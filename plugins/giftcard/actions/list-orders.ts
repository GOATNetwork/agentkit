import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type {
  GiftcardGateway,
  GiftcardOrderStatus,
  OrderListParams,
  OrderListResponse,
  OrderRecord,
} from '../adapters/types';
import { orderRecordSchema } from './order-schema';

export interface ListOrdersInput {
  status?: string;
  limit?: number;
  offset?: number;
}

export type ListOrdersOutput = OrderListResponse;

const inputSchema = z
  .object({
    status: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

const outputSchema = z.object({
  orders: z.array(orderRecordSchema),
  total: z.number().int(),
});

type GatewaySlice = Pick<GiftcardGateway, 'listOrders'>;

/**
 * Same caveat as `getOrder` re: `sensitiveOutputFields` shallow
 * redaction not reaching nested `card.*` fields — we flatten card.* up
 * to each order's top level so the hook redaction works.
 */
const SENSITIVE_OUTPUT_FIELDS = [
  'card_code',
  'card_pin',
  'card_link',
  'card_barcode',
] as const;

export function listOrdersAction(
  gateway: GatewaySlice,
): ActionDefinition<ListOrdersInput, ListOrdersOutput> {
  return {
    name: 'goat.giftcard.listOrders',
    description: 'List the authenticated wallet\'s giftcard orders, optionally filtered by status.',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: [],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    sensitiveOutputFields: [...SENSITIVE_OUTPUT_FIELDS],
    async execute(ctx, input) {
      const params: OrderListParams = {
        status: input.status as GiftcardOrderStatus | 'ALL' | undefined,
        limit: input.limit,
        offset: input.offset,
      };
      const resp = await gateway.listOrders(params, ctx.signal);
      return {
        ...resp,
        orders: resp.orders.map(flattenCardFields),
      };
    },
  };
}

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
