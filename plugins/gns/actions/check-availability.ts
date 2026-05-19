import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { GnsApiAdapter, SearchStatus } from '../adapters/types';
import { normalizeGoatName } from '../constants';

const inputSchema = z.object({
  name: z.string().min(1, 'name is required'),
});

export type CheckAvailabilityInput = z.infer<typeof inputSchema>;

const outputSchema = z.object({
  name: z.string(),
  normalized: z.string(),
  available: z.boolean(),
  status: z.custom<SearchStatus>((v) => v === 'available' || v === 'registered' || v === 'unsupported'),
});

export type CheckAvailabilityOutput = z.infer<typeof outputSchema>;

/**
 * `goat.gns.checkAvailability` — read-only availability lookup via gns-api
 * `/names/search?q=<label>`. The action normalizes the input (`Alice.GOAT` →
 * `alice.goat`) before issuing the request so callers don't need to worry
 * about case / suffix handling.
 */
export function checkAvailabilityAction(api: GnsApiAdapter): ActionDefinition<CheckAvailabilityInput, CheckAvailabilityOutput> {
  return {
    name: 'goat.gns.checkAvailability',
    description: 'Check whether a .goat name is available for registration',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    async execute(ctx, input) {
      const { fullName, label } = normalizeGoatName(input.name);
      const resp = await api.search(label, ctx.signal);
      const first = resp.results[0];
      const status: SearchStatus = first?.status ?? 'unsupported';
      return {
        name: input.name,
        normalized: fullName,
        available: status === 'available',
        status,
      };
    },
  };
}
