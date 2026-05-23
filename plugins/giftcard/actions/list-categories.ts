import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { Category, GiftcardGateway } from '../adapters/types';

export interface ListCategoriesInput {
  lang?: string;
}

export interface ListCategoriesOutput {
  categories: Category[];
}

const inputSchema = z
  .object({
    lang: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'lang must be BCP-47 (e.g. en, en-US)')
      .optional(),
  })
  .strict();

const outputSchema = z.object({
  categories: z.array(
    z
      .object({
        id: z.string(),
        name: z.string(),
      })
      .passthrough(),
  ),
});

type GatewaySlice = Pick<GiftcardGateway, 'listCategories'>;

export function listCategoriesAction(
  gateway: GatewaySlice,
): ActionDefinition<ListCategoriesInput, ListCategoriesOutput> {
  return {
    name: 'goat.giftcard.listCategories',
    description: 'List supported giftcard categories.',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: [],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    async execute(ctx, input) {
      const categories = await gateway.listCategories(input.lang, ctx.signal);
      return { categories };
    },
  };
}
