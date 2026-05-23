import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { Brand, GiftcardGateway } from '../adapters/types';

export interface ListBrandsInput {
  country?: string;
  category?: string;
  lang?: string;
}

export interface ListBrandsOutput {
  brands: Brand[];
}

const inputSchema = z
  .object({
    country: z
      .string()
      .regex(/^[A-Z]{2}$/, 'country must be ISO 3166-1 alpha-2 (e.g. US, CA)')
      .optional(),
    category: z.string().min(1).optional(),
    lang: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'lang must be BCP-47 (e.g. en, en-US)')
      .optional(),
  })
  .strict();

const brandSchema = z
  .object({
    id: z.string(),
    snaplii_brand_id: z.string().optional(),
    country: z.string(),
    category_id: z.string().nullable().optional(),
    name: z.string(),
    description: z.string().nullable().optional(),
    logo_url: z.string(),
    product_count: z.number(),
  })
  .passthrough();

const outputSchema = z.object({
  brands: z.array(brandSchema),
});

type GatewaySlice = Pick<GiftcardGateway, 'listBrands'>;

export function listBrandsAction(gateway: GatewaySlice): ActionDefinition<ListBrandsInput, ListBrandsOutput> {
  return {
    name: 'goat.giftcard.listBrands',
    description: 'List giftcard brands filtered by country / category / language.',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: [],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    async execute(ctx, input) {
      const brands = await gateway.listBrands(input, ctx.signal);
      return { brands };
    },
  };
}
