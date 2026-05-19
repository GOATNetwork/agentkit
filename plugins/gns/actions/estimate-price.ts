import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import { evmAddress } from '../../../core/schema/validators';
import type { GnsApiAdapter, RegistrationQuoteResponse } from '../adapters/types';
import { normalizeGoatName } from '../constants';

const inputSchema = z.object({
  name: z.string().min(1),
  years: z.number().int().min(1).max(10),
  tokenContract: evmAddress.optional() as z.ZodOptional<z.ZodType<`0x${string}`>>,
});

export type EstimatePriceInput = z.infer<typeof inputSchema>;

const outputSchema: z.ZodType<RegistrationQuoteResponse> = z.object({
  name: z.string(),
  years: z.number().int(),
  durationSeconds: z.string(),
  currency: z.string(),
  decimals: z.number().int(),
  registrationFee: z.string(),
  estimatedGas: z.string(),
  total: z.string(),
  totalWei: z.string(),
});

/**
 * `goat.gns.estimatePrice` — registration price quote via `/names/quote`.
 *
 * The optional `tokenContract` selects which ERC-20 the price is denominated
 * in (USDC/USDT, etc.). When omitted the API uses the network default.
 */
export function estimatePriceAction(
  api: GnsApiAdapter,
): ActionDefinition<EstimatePriceInput, RegistrationQuoteResponse> {
  return {
    name: 'goat.gns.estimatePrice',
    description: 'Quote the registration price for a .goat name and term in a chosen payment token',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    async execute(ctx, input) {
      const { fullName } = normalizeGoatName(input.name);
      return api.quote(
        {
          name: fullName,
          years: input.years,
          tokenContract: input.tokenContract,
        },
        ctx.signal,
      );
    },
  };
}
