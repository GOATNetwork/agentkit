import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import { evmAddress } from '../../../core/schema/validators';
import type { GnsApiAdapter, X402OrderResponse } from '../adapters/types';
import { normalizeGoatName } from '../constants';

const inputSchema = z.object({
  name: z.string().min(1),
  owner: evmAddress,
  payer: evmAddress,
  years: z.number().int().min(1).max(10),
  settlementChainId: z.number().int().positive(),
  settlementTokenSymbol: z.string().min(2).max(16),
  settlementTokenContract: evmAddress,
  secret: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  commitment: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  /** Optional pinned commit-bound max amount; backend payments.service uses this to recompute the bound commit hash. */
  commitMaxAmountWei: z.string().regex(/^\d+$/).optional(),
});

export type X402CreateOrderInput = z.infer<typeof inputSchema>;

const calldataSignRequestSchema = z.object({
  domain: z.record(z.unknown()),
  types: z.record(z.array(z.object({ name: z.string(), type: z.string() }))),
  primaryType: z.string().min(1),
  message: z.record(z.unknown()),
});

const outputSchema: z.ZodType<X402OrderResponse> = z.object({
  orderId: z.string().min(1),
  flow: z.string(),
  payToAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<`0x${string}`>,
  expiresAt: z.number(),
  chainId: z.number(),
  payChainId: z.number(),
  tokenSymbol: z.string(),
  tokenContract: z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<`0x${string}`>,
  fromAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<`0x${string}`>,
  amountWei: z.string(),
  callbackCalldata: z.string(),
  calldataSignRequest: calldataSignRequestSchema as unknown as z.ZodType<X402OrderResponse['calldataSignRequest']>,
});

/**
 * `goat.gns.x402.createOrder` — create a cross-chain register order via
 * `POST /payments/x402/register-order`.
 *
 * The action is a thin wrapper over the API: the source-of-truth for the
 * per-chain token contract + decimals is the response, not any client-side
 * registry. `networks: []` because the source chain is determined by
 * `settlementChainId` in the input, not by the runtime context's network.
 */
export function x402CreateOrderAction(
  api: GnsApiAdapter,
): ActionDefinition<X402CreateOrderInput, X402OrderResponse> {
  return {
    name: 'goat.gns.x402.createOrder',
    description: 'Create a cross-chain x402 order to register a .goat name from a non-GOAT chain',
    riskLevel: 'medium',
    requiresConfirmation: true,
    // Wildcard at action level — runtime PolicyEngine still gates per
    // `allowedNetworks`. The action issues an HTTP call only; the actual
    // chain validation happens in `payOrder`.
    networks: [],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    async execute(ctx, input) {
      const { fullName } = normalizeGoatName(input.name);
      return api.createX402Order(
        {
          name: fullName,
          owner: input.owner as `0x${string}`,
          payer: input.payer as `0x${string}`,
          years: input.years,
          settlementChainId: input.settlementChainId,
          settlementTokenSymbol: input.settlementTokenSymbol,
          settlementTokenContract: input.settlementTokenContract as `0x${string}`,
          secret: input.secret as `0x${string}`,
          commitment: input.commitment as `0x${string}` | undefined,
          commitMaxAmountWei: input.commitMaxAmountWei,
        },
        ctx.signal,
      );
    },
  };
}
