import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type {
  GiftcardGateway,
  GiftcardOrderStatus,
  OrderListParams,
  OrderListResponse,
} from '../adapters/types';
import { orderRecordSchema } from './order-schema';
import { ORDER_SENSITIVE_FIELDS, flattenCardFields } from './order-utils';

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
 * Card secrets live at the TOP level of each order, never in a nested
 * `card` object — the runtime's shallow-with-array-hop redactor walks
 * `output.orders[i]` and zeros the names below in each element, but
 * does NOT walk into nested objects. `flattenCardFields` (shared with
 * createOrder / getOrder via `./order-utils`) drops the backend's
 * nested `card` and promotes the four sensitive fields to the top
 * level on each element.
 */

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
    sensitiveOutputFields: [...ORDER_SENSITIVE_FIELDS],
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
