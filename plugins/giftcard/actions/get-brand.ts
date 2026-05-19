import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { BrandDetails, GiftcardGateway } from '../adapters/types';

export interface GetBrandInput {
  brand_id: string;
  lang?: string;
}

export type GetBrandOutput = BrandDetails;

const inputSchema = z
  .object({
    brand_id: z
      .string()
      .uuid({ message: 'brand_id must be a UUID' })
      .or(z.string().min(1)),
    lang: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'lang must be BCP-47 (e.g. en, en-US)')
      .optional(),
  })
  .strict();

const productSchema = z
  .object({
    product_id: z.string(),
    name: z.string(),
    face_value_type: z.union([z.literal('FIXED'), z.literal('VARIABLE')]),
    face_value_min: z.number(),
    face_value_max: z.number(),
    face_value_min_local: z.number().optional(),
    face_value_max_local: z.number().optional(),
    currency_local: z.string().optional(),
    sell_price_usd: z.number().optional(),
    sell_markup_pct: z.number().optional(),
    snaplii_discount: z.number().optional(),
    image_url: z.string().optional(),
    sold_out: z.boolean().optional(),
    unavailable_reason: z.string().optional(),
    max_buyable_face_value: z.number().optional(),
    denominations: z.array(z.number()).optional(),
  })
  .passthrough();

const outputSchema = z
  .object({
    brand: z
      .object({
        id: z.string(),
        name: z.string(),
        description: z.string().nullable().optional(),
        logo_url: z.string(),
        country: z.string(),
        currency_local: z.string().optional(),
        fx_rate_to_usd: z.number().optional(),
        category_id: z.string().nullable().optional(),
      })
      .passthrough(),
    products: z.array(productSchema),
  })
  .passthrough();

type GatewaySlice = Pick<GiftcardGateway, 'getBrand'>;

export function getBrandAction(gateway: GatewaySlice): ActionDefinition<GetBrandInput, GetBrandOutput> {
  return {
    name: 'goat.giftcard.getBrand',
    description: 'Fetch a giftcard brand with its product catalog (face-value constraints, denominations, markup).',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: [],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    async execute(ctx, input) {
      return gateway.getBrand(input.brand_id, input.lang, ctx.signal);
    },
  };
}
