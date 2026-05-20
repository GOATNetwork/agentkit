import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { GnsApiAdapter, NameDetailsResponse } from '../adapters/types';
import { normalizeGoatName } from '../constants';

const inputSchema = z.object({
  name: z.string().min(1),
});

export type GetNameDetailsInput = z.infer<typeof inputSchema>;

const recordSchema = z.object({
  key: z.string(),
  value: z.string(),
  shortValue: z.string().optional(),
  coinType: z.string().optional(),
  editable: z.boolean().optional(),
  format: z.string().optional(),
});

const outputSchema: z.ZodType<NameDetailsResponse> = z.object({
  name: z.string(),
  node: z.string(),
  status: z.union([z.literal('available'), z.literal('registered')]),
  lifecycleStatus: z.union([z.literal('available'), z.literal('active'), z.literal('grace-period')]),
  owner: z.string(),
  ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<`0x${string}`>,
  resolver: z.string(),
  resolverAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<`0x${string}`>,
  expiry: z.string(),
  gracePeriodEnds: z.string(),
  tokenId: z.string(),
  registrationDate: z.string(),
  primaryName: z.boolean(),
  avatar: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  // Live API returns an array (['twitter', 'github']); tolerate the legacy
  // key→handle map too so a backend shape change doesn't reject valid data.
  socialLinks: z.union([z.array(z.string()), z.record(z.string())]).optional(),
  records: z.array(recordSchema),
});

/**
 * `goat.gns.getNameDetails` — full lifecycle + records lookup via
 * `/names/details?name=<name>`.
 */
export function getNameDetailsAction(api: GnsApiAdapter): ActionDefinition<GetNameDetailsInput, NameDetailsResponse> {
  return {
    name: 'goat.gns.getNameDetails',
    description: 'Read full details (owner, expiry, resolver records) for a .goat name',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    async execute(ctx, input) {
      const { fullName } = normalizeGoatName(input.name);
      return api.details(fullName, ctx.signal);
    },
  };
}
