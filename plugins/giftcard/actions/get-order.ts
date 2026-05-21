import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { GiftcardGateway, OrderRecord } from '../adapters/types';
import { orderRecordSchema } from './order-schema';
import { ORDER_SENSITIVE_FIELDS, flattenCardFields } from './order-utils';

/**
 * Card secrets must live at the TOP level of the action's output, never
 * in a nested `card` object — the runtime redactor is shallow with a
 * one-hop array walk. The shared helpers in `./order-utils` (used by
 * `createOrder`, `getOrder`, and `listOrders`) drop the backend's
 * nested `card` and promote the four sensitive fields up to the top
 * level so `sensitiveOutputFields` can reach them. Keeping the helper
 * in one place ensures all three actions stay in sync.
 */

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

export function getOrderAction(gateway: GatewaySlice): ActionDefinition<GetOrderInput, GetOrderOutput> {
  return {
    name: 'goat.giftcard.getOrder',
    description: 'Fetch a giftcard order (including delivered card secrets once FULFILLED).',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: [],
    zodInputSchema: inputSchema,
    zodOutputSchema: orderRecordSchema,
    sensitiveOutputFields: [...ORDER_SENSITIVE_FIELDS],
    async execute(ctx, input) {
      return flattenCardFields(await gateway.getOrder(input.orderId, ctx.signal));
    },
  };
}
