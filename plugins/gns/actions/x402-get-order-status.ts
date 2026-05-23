import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { GnsApiAdapter, X402OrderStatusResponse } from '../adapters/types';

const inputSchema = z.object({
  orderId: z.string().min(1),
});

export type X402GetOrderStatusInput = z.infer<typeof inputSchema>;

const outputSchema: z.ZodType<X402OrderStatusResponse> = z.object({
  orderId: z.string(),
  status: z.string(),
  txHash: z.string().optional(),
  confirmedAt: z.number().optional(),
  raw: z.unknown().optional(),
});

/**
 * `goat.gns.x402.getOrderStatus` — poll `GET /payments/x402/orders/<orderId>`.
 *
 * `networks: []` because the read targets the GoatX402 backend, not a
 * specific chain context.
 */
export function x402GetOrderStatusAction(
  api: GnsApiAdapter,
): ActionDefinition<X402GetOrderStatusInput, X402OrderStatusResponse> {
  return {
    name: 'goat.gns.x402.getOrderStatus',
    description: 'Poll the cross-chain x402 register order status',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: [],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    async execute(ctx, input) {
      return api.getX402Order(input.orderId, ctx.signal);
    },
  };
}
